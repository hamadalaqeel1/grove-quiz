"""Browser end-to-end test for Grove.

Starts the server, opens the host screen and four phone-sized player browsers,
adds 18 bot players (22 in total) and plays the whole sample quiz. The QR code
is decoded from the host screen with OpenCV and followed like a phone camera
would.

Run: python3 test/e2e.py            (needs Python Playwright + Chromium, opencv-python, numpy)
Set SHOTS_DIR=/some/dir to save screenshots of each step.
"""
import json
import os
import re
import socket
import subprocess
import sys
import time
import urllib.request

import cv2
import numpy as np
from playwright.sync_api import expect, sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.environ.get('SHOTS_DIR')
BOTS = 18
LETTERS = 'ABCD'


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def sample_quiz():
    out = subprocess.check_output(
        ['node', '--input-type=module', '-e',
         "import { SAMPLE_QUIZ } from './public/js/sample-quiz.js'; console.log(JSON.stringify(SAMPLE_QUIZ));"],
        cwd=ROOT)
    return json.loads(out)


def wait_for_server(base, proc):
    for _ in range(100):
        if proc.poll() is not None:
            raise RuntimeError('server exited early:\n' + proc.stdout.read().decode())
        try:
            with urllib.request.urlopen(base + '/healthz', timeout=1) as r:
                if r.status == 200:
                    return
        except OSError:
            time.sleep(0.1)
    raise RuntimeError('server did not start')


def shot(page, name):
    if SHOTS:
        os.makedirs(SHOTS, exist_ok=True)
        page.screenshot(path=os.path.join(SHOTS, f'{name}.png'), full_page=True)


def assert_no_overflow(page, label):
    overflow = page.evaluate('document.documentElement.scrollWidth - window.innerWidth')
    assert overflow <= 1, f'{label}: page scrolls sideways by {overflow}px'


def main():
    quiz = sample_quiz()
    port = free_port()
    base = f'http://127.0.0.1:{port}'
    env = {**os.environ, 'PORT': str(port), 'HOST': '127.0.0.1'}
    env.pop('PUBLIC_URL', None)
    server = subprocess.Popen(['node', 'src/server.js'], cwd=ROOT, env=env,
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    bots = None
    problems = []
    checks = 0

    def check(cond, message):
        nonlocal checks
        checks += 1
        assert cond, message

    try:
        wait_for_server(base, server)
        with sync_playwright() as p:
            browser = p.chromium.launch()

            def watch(page, label):
                page.on('console', lambda m: problems.append(f'{label} console {m.type}: {m.text}')
                        if m.type in ('error', 'warning') else None)
                page.on('pageerror', lambda e: problems.append(f'{label} page error: {e}'))
                page.on('dialog', lambda d: d.accept())

            # ---------- Host creates a room ----------
            host_ctx = browser.new_context(viewport={'width': 1440, 'height': 900})
            host = host_ctx.new_page()
            watch(host, 'host')
            host.goto(base + '/host')
            expect(host.locator('.q-card')).to_have_count(len(quiz['questions']))
            shot(host, '01-host-editor')

            host.fill('#f-title', '')
            host.get_by_role('button', name='Create room').first.click()
            expect(host.locator('#error-summary')).to_be_visible()
            expect(host.locator('#e-title')).to_contain_text('Give your quiz a title')
            check(host.locator('#f-title').get_attribute('aria-invalid') == 'true', 'title marked invalid')
            shot(host, '02-host-validation')
            host.fill('#f-title', 'Green Planet')
            expect(host.locator('#error-summary')).to_be_hidden()

            host.get_by_role('button', name='Create room').first.click()
            expect(host.locator('.room-code')).to_be_visible()
            code = re.sub(r'\D', '', host.text_content('.room-code'))
            check(re.fullmatch(r'[1-9]\d{5}', code) is not None, f'room code looks wrong: {code}')
            expect(host.locator('.join-url')).to_have_text(f'{base}/join/{code}')

            # ---------- The QR code opens the join page ----------
            # (wait_for_function would need 'unsafe-eval', which Grove's CSP rightly blocks)
            for _ in range(100):
                if host.evaluate("() => { const i = document.querySelector('.qr img'); return i.complete && i.naturalWidth > 0; }"):
                    break
                time.sleep(0.05)
            png = host.locator('.qr img').screenshot()
            img = cv2.imdecode(np.frombuffer(png, np.uint8), cv2.IMREAD_COLOR)
            decoded, _, _ = cv2.QRCodeDetector().detectAndDecode(img)
            check(decoded == f'{base}/join/{code}', f'QR decodes to {decoded!r}')
            print(f'QR code decodes to {decoded}')

            def phone(device, label):
                ctx = browser.new_context(**p.devices[device])
                page = ctx.new_page()
                watch(page, label)
                return page

            # Player 1 scans the QR code.
            p1 = phone('iPhone 13', 'p1')
            p1.goto(decoded)
            expect(p1.locator('#room-info')).to_contain_text('Green Planet')
            check(re.sub(r'\D', '', p1.input_value('#code')) == code, 'QR link pre-fills the room code')
            shot(p1, '03-phone-join-from-qr')
            p1.fill('#name', 'Ana')
            p1.click('#join-btn')
            expect(p1.get_by_role('heading', name='You’re in!')).to_be_visible()
            shot(p1, '04-phone-lobby')

            # Player 2 types the code on the home page.
            p2 = phone('Pixel 5', 'p2')
            p2.goto(base + '/')
            p2.fill('#code', code)
            expect(p2.locator('#room-info')).to_be_visible()
            p2.fill('#name', 'Ben')
            p2.click('#join-btn')
            expect(p2.get_by_role('heading', name='You’re in!')).to_be_visible()
            check(p2.url.endswith(f'/join/{code}'), 'URL updated to the room link')

            # Player 3 uses a ?code= link on a small phone.
            p3 = phone('iPhone SE', 'p3')
            p3.goto(f'{base}/join?code={code}')
            p3.fill('#name', 'Chen')
            p3.click('#join-btn')
            expect(p3.get_by_role('heading', name='You’re in!')).to_be_visible()

            # Player 4 makes mistakes first: an unknown code, then a taken name.
            p4 = phone('Galaxy S9+', 'p4')
            p4.goto(base + '/')
            p4.click('#join-btn')
            expect(p4.locator('#code-error')).to_contain_text('Enter the six-digit room code')
            expect(p4.locator('#name-error')).to_contain_text('Enter a display name')
            bad = '100000' if code != '100000' else '100001'
            p4.fill('#code', bad)
            expect(p4.locator('#code-error')).to_contain_text('no live room')
            p4.fill('#name', 'Dee')
            p4.click('#join-btn')
            expect(p4.locator('#code-error')).to_contain_text('no live room')
            shot(p4, '05-phone-bad-code')
            p4.fill('#code', code)
            p4.fill('#name', 'ana')
            p4.click('#join-btn')
            expect(p4.locator('#name-error')).to_contain_text('already uses that name')
            p4.fill('#name', 'Dee')
            p4.click('#join-btn')
            expect(p4.get_by_role('heading', name='You’re in!')).to_be_visible()

            phones = [p1, p2, p3, p4]
            for i, page in enumerate(phones):
                assert_no_overflow(page, f'p{i + 1} lobby')

            # 18 more players join as bots.
            bots = subprocess.Popen(['node', 'test/bots.js', base, code, str(BOTS), 'Bot', '2500'], cwd=ROOT,
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            total = 4 + BOTS
            expect(host.locator('.roster-head h2')).to_have_text(f'{total} players', timeout=15000)
            expect(host.locator('.roster .chip')).to_have_count(total)
            shot(host, '06-host-lobby-22')

            # Host locks the room; a latecomer is turned away; host unlocks.
            host.get_by_role('button', name='Lock room').click()
            expect(host.get_by_role('button', name='Unlock room')).to_be_visible()
            late = phone('iPhone 13', 'late')
            late.goto(f'{base}/join/{code}')
            expect(late.locator('#code-error')).to_contain_text('isn’t letting new players in')
            host.get_by_role('button', name='Unlock room').click()
            expect(host.get_by_role('button', name='Lock room')).to_be_visible()
            late.context.close()

            # ---------- Play every question ----------
            last_q = len(quiz['questions']) - 1
            for qi, q in enumerate(quiz['questions']):
                correct = q['correct']
                wrong = (correct + 1) % 4
                is_last = qi == last_q
                if qi == 0:
                    host.get_by_role('button', name='Start quiz').click()
                else:
                    host.get_by_role('button', name='Next question').click()
                expect(host.locator('h1.q-text')).to_have_text(q['text'])
                for page in phones:
                    expect(page.locator('h1.q-text')).to_have_text(q['text'])
                    expect(page.locator('button.answer')).to_have_count(4)
                    check(page.locator('.is-correct').count() == 0, 'no correct answer marked before reveal')
                    check(q['choices'][correct] in page.locator('.answers').inner_text(), 'choices shown on phones')
                    expect(page.locator('.timer')).to_be_visible()
                check(host.locator('.is-correct').count() == 0, 'host stage hides the answer while open')
                if qi == 0:
                    shot(host, '07-host-question')
                    shot(p1, '08-phone-question')

                # Ana answers correctly first, Ben answers wrong, Chen double-taps,
                # Dee doesn't answer at all.
                p1.locator('button.answer').nth(correct).click()
                p2.locator('button.answer').nth(wrong).click()
                p3.locator('button.answer').nth(correct).dblclick()
                for page in (p1, p2, p3):
                    expect(page.locator('.answer-status')).to_contain_text('locked in')
                    check(page.locator('button.answer[disabled]').count() == 4, 'answers lock after one tap')
                if qi == 0:
                    shot(p1, '09-phone-answer-locked')
                    assert_no_overflow(p3, 'small phone question')

                # Wait for the 18 bots too, so scoring is exercised with 21-22 answers.
                expect(host.locator('.answered-count strong')).to_have_text('21', timeout=15000)
                if is_last:
                    # Dee answers last: everyone connected has answered, so the
                    # question closes by itself without the host ending it.
                    p4.locator('button.answer').nth(wrong).click()
                    expect(host.locator('.closed-badge')).to_have_text('Everyone answered')
                else:
                    host.get_by_role('button', name='End question now').click()
                    expect(host.locator('.closed-badge')).to_have_text('Question closed')
                if qi == 0:
                    shot(host, '10-host-locked')
                    # A late tap after the question closed is refused.
                    expect(p4.locator('.answer-status')).to_contain_text('No answer from you')
                    check(p4.locator('button.answer').count() == 0, 'late player cannot tap answers')

                host.get_by_role('button', name='Reveal answer').click()
                expect(host.locator('.answers .answer.is-correct')).to_have_count(1)
                expect(host.locator('.answers .answer.is-correct')).to_contain_text(q['choices'][correct])
                expect(p1.get_by_role('heading', name='Correct!')).to_be_visible()
                expect(p2.get_by_role('heading', name='Not this time')).to_be_visible()
                expect(p3.get_by_role('heading', name='Correct!')).to_be_visible()
                expect(p4.get_by_role('heading', name='Not this time' if is_last else 'No answer')).to_be_visible()
                counts = [int(t.split()[0]) for t in host.locator('.answer-count').all_inner_texts()]
                check(sum(counts) == (22 if is_last else 21), f'answer distribution {counts}')
                if qi == 0:
                    shot(host, '11-host-reveal')
                    shot(p1, '12-phone-correct')
                    shot(p2, '13-phone-wrong')
                    # Reloading the page rejoins the same player without losing state.
                    p2.reload()
                    expect(p2.get_by_role('heading', name='Not this time')).to_be_visible()
                    expect(p2.locator('#meta')).to_contain_text(code[:3])

                host.get_by_role('button', name='Show standings').click()
                expect(host.get_by_role('heading', name='Standings')).to_be_visible()
                top = [r.get_attribute('data-player-id') for r in host.locator('.board-top .row').all()]
                bottom = [r.get_attribute('data-player-id') for r in host.locator('.board-bottom .row').all()]
                check(len(top) == 3 and len(bottom) == 3, f'top/bottom sizes {len(top)}/{len(bottom)}')
                check(len(set(top + bottom)) == 6, f'standings list someone twice: {top + bottom}')
                for page in phones:
                    expect(page.get_by_role('heading', name='Standings')).to_be_visible()
                    expect(page.locator('.my-position')).to_be_visible()
                if qi == 0:
                    shot(host, '14-host-standings')
                    shot(p1, '15-phone-standings')
                    host.set_viewport_size({'width': 390, 'height': 844})
                    assert_no_overflow(host, 'host standings on a phone-sized screen')
                    host.set_viewport_size({'width': 1440, 'height': 900})

            # ---------- Final results ----------
            host.get_by_role('button', name='Show final results').click()
            expect(host.get_by_role('heading', name='Final results')).to_be_visible()
            expect(host.locator('.podium-place:not(.is-empty)')).to_have_count(3)
            host.locator('details.full-results summary').click()
            expect(host.locator('.results-table tbody tr')).to_have_count(total)
            shot(host, '16-host-final')
            for page in phones:
                expect(page.get_by_role('heading', name='Final results')).to_be_visible()
                expect(page.locator('.my-position')).to_contain_text('You finished')
                assert_no_overflow(page, 'final')
            shot(p1, '17-phone-final')
            bot_scores = [int(r.locator('td').nth(3).inner_text().replace(',', ''))
                          for r in host.locator('.results-table tbody tr').all()
                          if r.locator('td').nth(1).inner_text().startswith('Bot')]
            check(len(bot_scores) == BOTS and any(sc > 0 for sc in bot_scores), f'bot scores {bot_scores}')
            ana_rank = p1.locator('.my-position strong').inner_text()
            print(f'Ana (always first and correct) finished: {ana_rank}')

            # A new player can't join a finished quiz.
            after = phone('iPhone 13', 'after')
            after.goto(f'{base}/join/{code}')
            expect(after.locator('#code-error')).to_contain_text('already ended')

            # Host closes the room; players are told.
            host.get_by_role('button', name='Close room').click()
            expect(p1.get_by_role('heading', name='The host closed this room')).to_be_visible()
            expect(host.get_by_role('heading', name='Write your quiz')).to_be_visible()
            shot(p1, '18-phone-room-closed')

            browser.close()
    finally:
        if bots:
            bots.terminate()
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()

    # p4 deliberately looks up a room code that doesn't exist (404).
    problems = [x for x in problems if not (x.startswith('p4 ') and 'status of 404' in x)]
    if problems:
        print('Browser console problems:')
        for line in problems:
            print('  ' + line)
        sys.exit(1)
    print(f'E2E passed: {checks} explicit checks plus Playwright expectations, 22 players, {len(quiz["questions"])} questions.')


if __name__ == '__main__':
    main()
