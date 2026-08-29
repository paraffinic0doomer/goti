import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const API = 'http://127.0.0.1:3000';
const WEB = 'http://localhost:5173';
const OUTPUT = 'C:\\hack_outcast\\goti\\screenshots';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PASSWORD = 'readme-demo-password-2026';

const users = [
  { phone: '+8801998765401', displayName: 'Amina Rahman', email: 'amina.readme@example.com' },
  { phone: '+8801998765402', displayName: 'Rafi Ahmed', email: 'rafi.readme@example.com' },
];

const securityAnswers = [
  { questionKey: 'FIRST_SCHOOL', answer: 'dhaka' },
  { questionKey: 'BEST_FRIEND_NAME', answer: 'dhaka' },
  { questionKey: 'BIRTH_CITY', answer: 'dhaka' },
];

async function api(path, { token, method = 'GET', body } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.message ?? `${method} ${path} failed`);
    error.status = response.status;
    error.code = payload.code;
    throw error;
  }
  return payload;
}

async function ensureUser(user) {
  try {
    return await api('/auth/register', {
      method: 'POST',
      body: { ...user, password: PASSWORD, securityAnswers },
    });
  } catch (error) {
    if (error.status !== 409) throw error;
    return api('/auth/login', {
      method: 'POST',
      body: { phone: user.phone, password: PASSWORD },
    });
  }
}

async function ignoreExpected(action) {
  try {
    return await action();
  } catch (error) {
    if ([400, 409].includes(error.status)) return null;
    throw error;
  }
}

async function prepareDemoData() {
  const amina = await ensureUser(users[0]);
  const rafi = await ensureUser(users[1]);

  await api('/wallet/send-money', {
    token: amina.accessToken,
    method: 'POST',
    body: {
      receiverPhone: users[1].phone,
      amount: 123456,
      idempotencyKey: 'README_SEND_AMINA_RAFI_V1',
      note: 'Shared project costs',
    },
  });

  const budget = await api('/envelopes', { token: amina.accessToken });
  let reserve = budget.envelopes.find((item) => item.name === 'Monthly essentials');
  if (!reserve) {
    const created = await api('/envelopes', {
      token: amina.accessToken,
      method: 'POST',
      body: { name: 'Monthly essentials', category: 'Budget', icon: 'HOME', targetAmount: 1500000 },
    });
    reserve = created.envelopes.find((item) => item.name === 'Monthly essentials');
    if (reserve) {
      await api(`/envelopes/${reserve.id}/reserve`, {
        token: amina.accessToken,
        method: 'POST',
        body: { amount: 500000 },
      });
    }
  }

  const pots = await api('/pots?page=1&pageSize=20', { token: amina.accessToken });
  if (!pots.items.some((item) => item.name === 'Cox\'s Bazar Trip')) {
    await api('/pots', {
      token: amina.accessToken,
      method: 'POST',
      body: { name: 'Cox\'s Bazar Trip', note: 'Group travel fund', targetAmount: 2000000 },
    });
  }

  const outgoing = await api('/money-requests?role=requester&page=1&pageSize=100', {
    token: amina.accessToken,
  });
  if (!outgoing.items.some((item) => item.note === 'Dinner share')) {
    await ignoreExpected(() =>
      api('/money-requests', {
        token: amina.accessToken,
        method: 'POST',
        body: {
          payerPhone: users[1].phone,
          amount: 75000,
          idempotencyKey: 'README_REQUEST_DINNER_V1',
          note: 'Dinner share',
        },
      }),
    );
  }

  const incomingForAmina = await api('/money-requests?role=payer&page=1&pageSize=100', {
    token: amina.accessToken,
  });
  if (!incomingForAmina.items.some((item) => item.note === 'Equipment share')) {
    await ignoreExpected(() =>
      api('/money-requests', {
        token: rafi.accessToken,
        method: 'POST',
        body: {
          payerPhone: users[0].phone,
          amount: 95000,
          idempotencyKey: 'README_REQUEST_EQUIPMENT_V1',
          note: 'Equipment share',
        },
      }),
    );
  }

  return { amina, rafi };
}

class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  call(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForChrome(port) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error('Chrome debugging endpoint did not start.');
}

async function main() {
  await mkdir(OUTPUT, { recursive: true });
  const auth = await prepareDemoData();
  const profile = await mkdtemp(join(tmpdir(), 'goti-readme-chrome-'));
  const port = 9333;
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--remote-allow-origins=*',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--window-size=1440,1000',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  try {
    await waitForChrome(port);
    const targetResponse = await fetch(
      `http://127.0.0.1:${port}/json/new?${encodeURIComponent(`${WEB}/login`)}`,
      { method: 'PUT' },
    );
    const target = await targetResponse.json();
    const cdp = new CdpClient(target.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.call('Page.enable');
    await cdp.call('Runtime.enable');
    await cdp.call('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await delay(1200);

    const waitForDocument = async () => {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const state = await cdp.call('Runtime.evaluate', {
          expression: 'document.readyState',
          returnByValue: true,
        });
        if (state.result?.value === 'complete') return;
        await delay(100);
      }
    };

    const login = async () => {
      await cdp.call('Page.navigate', { url: `${WEB}/login` });
      await waitForDocument();
      await delay(600);
      const result = await cdp.call('Runtime.evaluate', {
        expression: `(() => {
          const inputs = Array.from(document.querySelectorAll('input'));
          const setValue = (input, value) => {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
            setter.call(input, value);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
          };
          setValue(inputs[0], ${JSON.stringify(users[0].phone)});
          setValue(inputs[1], ${JSON.stringify(PASSWORD)});
          document.querySelector('form').requestSubmit();
          return inputs.length;
        })()`,
        returnByValue: true,
      });
      if (result.result?.value < 2) throw new Error('Login form was not found.');
      await delay(2200);
      const state = await cdp.call('Runtime.evaluate', {
        expression: `({ location: location.pathname, session: Boolean(sessionStorage.getItem('goti.session')) })`,
        returnByValue: true,
      });
      if (!state.result?.value?.session) {
        throw new Error(`Browser login failed: ${JSON.stringify(state.result?.value)}`);
      }
    };

    const capture = async (path, filename) => {
      await cdp.call('Runtime.evaluate', {
        expression: `history.pushState({}, '', ${JSON.stringify(path)}); window.dispatchEvent(new PopStateEvent('popstate'));`,
      });
      await delay(2200);
      const state = await cdp.call('Runtime.evaluate', {
        expression: `({ location: location.pathname, session: Boolean(sessionStorage.getItem('goti.session')) })`,
        returnByValue: true,
      });
      process.stdout.write(`${filename}: ${JSON.stringify(state.result?.value)}\n`);
      const result = await cdp.call('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
      });
      await writeFile(join(OUTPUT, filename), Buffer.from(result.data, 'base64'));
    };

    await login();
    await capture('/', 'web-dashboard.png');
    await capture('/transactions', 'web-transactions.png');
    await capture('/envelopes', 'web-envelopes.png');
    await capture('/pots', 'web-pots.png');
    await capture('/requests', 'web-requests.png');
    await capture('/security', 'web-security.png');
    await capture('/monitor', 'web-monitor.png');
    await cdp.call('Browser.close');
  } finally {
    if (!chrome.killed) chrome.kill();
    await delay(800);
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

await main();
