"""Real Chromium + production panel + real loopback HTTP. Parent owns server/test controls."""
import argparse
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

parser = argparse.ArgumentParser()
parser.add_argument('--url', required=True)
parser.add_argument('--ticket', required=True)
parser.add_argument('--out', required=True)
parser.add_argument('--artifact', required=True)
parser.add_argument('--phase', choices=['initial', 'history'], default='initial')
parser.add_argument('--chromium', default='/usr/bin/google-chrome')
parser.add_argument('--marker', default='E2E-READY')
args = parser.parse_args()
out = Path(args.out)
out.mkdir(parents=True, exist_ok=True)
errors = []

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path=args.chromium)
    context = browser.new_context(accept_downloads=True, viewport={'width': 1280, 'height': 1100})
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.add_init_script('sessionStorage.setItem("dsh-superagent/route", ' + json.dumps(json.dumps({
        'route': {'page': 'execution', 'id': args.ticket}, 'stack': []})) + ')')
    page.goto(args.url)
    page.wait_for_load_state('networkidle')
    expect(page.get_by_text('DAL evidence', exact=True)).to_be_visible()
    evidence = page.locator('.dt-worker-evidence')
    if args.phase == 'initial':
        expect(evidence.get_by_text('Not checked', exact=False)).to_be_visible()
        page.get_by_label('Check 1 value', exact=True).fill(args.marker)
        page.get_by_role('button', name='Freeze checks', exact=True).click()
        page.get_by_role('button', name='Confirm', exact=True).click()
        expect(page.locator('input[type=file]')).to_be_visible()
        for path in [args.artifact, str(out / 'altered.txt'), args.artifact]:
            page.locator('input[type=file]').set_input_files(path)
            with page.expect_response(lambda response: response.url.endswith('/artifact-check')) as reply:
                page.get_by_role('button', name='Check supplied artifact', exact=True).click()
            assert reply.value.status == 200, reply.value.text()
            expected = 'Failed' if path.endswith('altered.txt') else 'Passed'
            expect(evidence.locator(':scope > p').filter(has_text='Supplied-artifact checks:')).to_have_text('Supplied-artifact checks: ' + expected)
        expect(page.get_by_text('Unverified', exact=True)).to_be_visible()
        expect(page.get_by_text('Unattested', exact=True)).to_be_visible()
        with page.expect_download() as download:
            page.get_by_role('button', name='Download DAL observation', exact=True).click()
        download.value.save_as(out / 'observation.json')
        assert download.value.suggested_filename.startswith('obs-')
        page.screenshot(path=str(out / 'panel-en.png'), full_page=True)
        page.goto(args.url + '?lang=zh')
        page.wait_for_load_state('networkidle')
        expect(page.get_by_text('尚未验证', exact=True)).to_be_visible()
        expect(page.locator('.dt-worker-evidence').get_by_text('所提供文件的检查: 通过', exact=True)).to_be_visible()
        page.screenshot(path=str(out / 'panel-zh.png'), full_page=True)
    else:
        expect(evidence.locator(':scope > p').filter(has_text='Supplied-artifact checks:')).to_have_text('Supplied-artifact checks: Not checked')
        history = evidence.locator('details').filter(has=page.locator('summary', has_text='Historical Assignment evidence'))
        history.locator(':scope > summary').click()
        expect(history.get_by_text('Supplied-artifact checks: Passed', exact=True)).to_be_visible()
        expect(page.get_by_text('Unverified', exact=True)).to_be_visible()
        page.screenshot(path=str(out / 'panel-successor.png'), full_page=True)
    assert not errors, errors
    (out / ('browser-' + args.phase + '.json')).write_text(json.dumps({'status': 'passed', 'phase': args.phase,
        'browser': browser.version, 'page_errors': errors, 'real_http': True, 'production_panel': True}, indent=2) + '\n')
    context.close()
    browser.close()
