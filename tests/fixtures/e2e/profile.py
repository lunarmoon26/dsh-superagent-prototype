"""Boot the installed DSH Web profile and built bundle, without accounts, work or model calls."""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[3]
OUTPUT = ROOT / '.artifacts' / 'profile-smoke'
OUTPUT.mkdir(parents=True, exist_ok=True)
run = Path(tempfile.mkdtemp(prefix='run-', dir=OUTPUT))
home = run / 'home'
home.mkdir(mode=0o700)
dsh = shutil.which('dsh')
chromium = os.environ.get('E2E_CHROMIUM', '/usr/bin/google-chrome')
env = {key: os.environ[key] for key in ['PATH', 'LANG', 'LC_ALL', 'SYSTEMROOT'] if key in os.environ}
env.update(HOME=str(home), DSH_HOME=str(home / '.dsh'), XDG_CONFIG_HOME=str(home / '.config'),
           XDG_CACHE_HOME=str(home / '.cache'), XDG_DATA_HOME=str(home / '.local' / 'share'),
           DSH_TELEMETRY_MODE='DISABLED')


def redact(text):
    return re.sub(r'([?&]token=)[^\s&]+', r'\1[REDACTED]', text)


def command(name, args):
    result = subprocess.run(args, cwd=run, env=env, capture_output=True, text=True, timeout=60)
    (run / (name + '.log')).write_text(redact(result.stdout + result.stderr))
    if result.returncode:
        raise RuntimeError(name + ' failed; see its retained log')
    return result.stdout


def boot_and_check(browser, phase):
    log_path = run / (phase + '.log')
    errors = []
    with log_path.open('w') as log:
        child = subprocess.Popen([dsh, 'e2e-smoke'], cwd=run, env=env, stdout=log, stderr=subprocess.STDOUT)
        try:
            deadline = time.monotonic() + 45
            url = None
            while time.monotonic() < deadline:
                text = log_path.read_text()
                match = re.search(r'dsh web: (http://127\.0\.0\.1:\d+/\?token=\S+)', text)
                if match:
                    url = match[1]
                    break
                if child.poll() is not None:
                    raise RuntimeError('Profile exited before serving its Web shell')
                time.sleep(.1)
            if not url:
                raise RuntimeError('Profile did not announce its loopback URL within 45 seconds')
            context = browser.new_context(viewport={'width': 1440, 'height': 1100})
            try:
                page = context.new_page()
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.goto(url, timeout=30_000)
                page.wait_for_load_state('networkidle')
                preview = page.get_by_role('button', name='Continue', exact=True)
                sign_in = page.get_by_role('heading', name='Get started', exact=True)
                expect(preview.or_(sign_in).first).to_be_visible()
                # The preview acknowledgement persists in native host settings across restart.
                if preview.is_visible():
                    preview.click()
                # A fresh account-free Web profile offers sign-in after the preview notice.
                # Dismiss the real dialog; never bypass its mask or start an OAuth flow.
                expect(sign_in).to_be_visible()
                page.get_by_role('button', name='Close', exact=True).click()
                expect(page.get_by_text('Default workspace', exact=True).first).to_be_visible()
                page.get_by_text('Superagent', exact=True).click()
                expect(page.locator('.dt-page')).to_be_visible()
                expect(page.get_by_text('The GitHub Source names no repository.', exact=True)).to_be_visible()
                state = page.evaluate('''async () => {
                    const response = await fetch('/orchestrator/api/state', {headers: {'x-orchestrator-request': '1'}});
                    if (!response.ok) throw new Error('Management state HTTP ' + response.status);
                    return response.json();
                }''')
                assert state['setup']['problem']['code'] == 'repositoryUnset'
                assert state['setup']['accounts'] is None
                assert state['load']['running'] == state['load']['queued'] == 0
                assert state['health']['runtime']['code'] == 'setupPending'
                assert not any(value['state'] == 'error' for value in state['health'].values())
                assert Path(state['setup']['machine']['stateDir']) == run / 'state'
                assert (home / 'Documents' / 'deepseek-harness' / 'default-workspace').is_dir()
                assert 'Unable to create default workspace' not in page.locator('body').inner_text()
                assert not errors, errors
                (run / (phase + '-state.json')).write_text(json.dumps(state, indent=2) + '\n')
                page.screenshot(path=str(run / (phase + '-panel.png')), full_page=True)
                return {'master_id': state['masterId'], 'page_errors': errors, 'setup': 'repositoryUnset'}
            except Exception:
                page.screenshot(path=str(run / (phase + '-failure.png')), full_page=True)
                (run / (phase + '-failure-text.txt')).write_text(redact(page.locator('body').inner_text()))
                raise
            finally:
                context.close()
        finally:
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=5)
                    raise RuntimeError('Test-owned profile required forced shutdown')
            log.flush()
            text = log_path.read_text()
            log_path.write_text(redact(text))
            if child.returncode != 0:
                raise RuntimeError('Test-owned profile did not exit cleanly')
            if 'did not activate' in text or 'ValidationError:' in text:
                raise RuntimeError('Profile boot contained inactive entries or configuration failures')


try:
    if not dsh or not Path(chromium).is_file() or not (ROOT / 'lib' / 'client.js').is_file():
        raise RuntimeError('Needs installed dsh, E2E_CHROMIUM and pnpm build before execution')
    version = command('version', [dsh, '--version']).strip()
    if version != '0.2.1-rc.5':
        raise RuntimeError('Profile smoke requires the verified DSH 0.2.1-rc.5 installation')
    # Fresh private HOME/DSH_HOME, no inherited provider keys, shared profile or shared credential store.
    command('init', [dsh, 'e2e-smoke', '--from-default-profile', 'web', '--dump-config'])
    command('install', [dsh, 'plugin', '--profile', 'e2e-smoke', 'add', 'link:' + str(ROOT)])
    profile = home / '.dsh' / 'profiles' / 'e2e-smoke'
    (profile / 'cordis.patch.yml').write_text('''- id: webserver
  config:
    host: 127.0.0.1
    port: 0
- id: web-runtime
  config:
    openBrowser: false
- id: workspace-controller
  config:
    documentsDirectory: ''' + json.dumps(str(home / 'Documents')) + '''
- id: dsh-superagent
  config:
    stateDir: ''' + json.dumps(str(run / 'state')) + '''
- id: dsh-superagent-github
  disabled: true
- id: dsh-superagent-feishu
  disabled: true
''')
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, executable_path=chromium)
        try:
            initial = boot_and_check(browser, 'initial')
            reopened = boot_and_check(browser, 'reopened')
            assert initial['master_id'] == reopened['master_id']
        finally:
            browser.close()
    receipt = {'status': 'passed', 'dsh_version': version, 'initial': initial, 'reopened': reopened,
               'coverage': {'full_web_profile_boot': True, 'built_plugin_and_client': True,
                            'native_web_shell': True, 'native_services': True, 'native_workspace_created': True, 'clean_restart': True,
                            'real_chromium': True, 'ready_for_work': False, 'source_plugins': False,
                            'credentials_configured': False, 'live_model': False,
                            'general_coding_tools_executed': False, 'os_worker_isolation': False,
                            'external_delivery': False, 'promotion': False}}
    (run / 'receipts.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps({'status': 'passed', 'evidence': str(run / 'receipts.json')}))
except Exception as error:
    (run / 'failure.json').write_text(json.dumps({'status': 'failed', 'error': redact(str(error))}, indent=2) + '\n')
    print(json.dumps({'status': 'failed', 'evidence': str(run)}))
    raise SystemExit(1)
