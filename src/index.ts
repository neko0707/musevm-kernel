import { Container, getContainer } from "@cloudflare/containers";

// Lifecycle model (Cloudflare Containers): nothing runs until a request
// arrives; the Worker starts an instance on demand, the instance sleeps
// after `sleepAfter` of inactivity. /cf-containers is the control surface:
//
//   GET  /cf-containers                 control page (lifecycle + kernel)
//   POST /cf-containers/start|stop|restart|status
//                                       container instance lifecycle
//   *    /cf-containers/agent/<path>    proxied to the in-container agent
//                                       (container-agent.py on port 8080):
//     GET  agent/status                 system + kernel artifact status
//     POST agent/kernel/boot-test       QEMU boot smoke test of the bzImage
//
// The image carries the minimized kernel artifact (bzImage + its .config,
// reassembled and SHA-256-verified at image build time) plus the kernel
// build toolchain and QEMU. The container never boots that kernel as its
// host kernel; the bzImage is cargo and test subject.
//
// Access control: if the CONTROL_TOKEN secret is set (wrangler secret put
// CONTROL_TOKEN), it acts as an HMAC-SHA256 key: every control API request
// must carry X-Timestamp and X-Signature = HMAC(key, "<METHOD>\n<path>\n
// <timestamp>"), verified with crypto.subtle.verify; timestamps more than
// 300 s off are rejected. The secret itself is never sent. Without it the
// page is open to anyone who knows the URL — put the Worker behind
// Cloudflare Access before using this beyond experiments.
export class KernelContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "10m";

  async startContainer() {
    await this.start();
    return this.getState();
  }

  async stopContainer() {
    await this.stop();
    let state = await this.getState();
    if (state.status !== "stopped") {
      // stop() signals the entrypoint and waits for a graceful exit; an
      // instance whose processes linger can stay "healthy" indefinitely.
      // Escalate to destroy(), which force-terminates the instance.
      await this.destroy();
      state = await this.getState();
    }
    return state;
  }

  async restartContainer() {
    await this.stop();
    const state = await this.getState();
    if (state.status !== "stopped") {
      await this.destroy();
    }
    await this.start();
    return this.getState();
  }

  async containerState() {
    return this.getState();
  }
}

interface Env {
  KERNEL_CONTAINER: DurableObjectNamespace<KernelContainer>;
  CONTROL_TOKEN?: string;
}

const INSTANCE = "main";

const CONTROL_PAGE = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>cf-containers — musevm-kernel-worker</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 44rem; padding: 0 1rem; }
  h1 { font-size: 1.25rem; }
  h2 { font-size: 1.05rem; margin-top: 2rem; }
  .row { display: flex; gap: 0.5rem; margin: 0.75rem 0; flex-wrap: wrap; }
  button { padding: 0.5rem 1rem; font-size: 1rem; cursor: pointer; }
  button:disabled { opacity: 0.45; cursor: not-allowed; }
  .btn-green { background: transparent; border: 2px solid #1a7f37; color: #1a7f37; font-weight: 600; }
  .btn-yellow { background: transparent; border: 2px solid #bf8700; color: #9a6700; font-weight: 600; }
  .btn-fill-green { background: #b7ebc0; border: 2px solid #1a7f37; color: #14532d; font-weight: 600; }
  .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.45); display: flex; align-items: center; justify-content: center; z-index: 10; }
  .modal-overlay[hidden] { display: none; }
  .modal-box { background: #fff; color: #111; padding: 1.25rem 1.5rem; border-radius: 8px; max-width: 24rem; width: calc(100% - 3rem); }
  @media (prefers-color-scheme: dark) { .modal-box { background: #1c1c1e; color: #eee; } }
  pre { background: #8882; padding: 1rem; overflow-x: auto; min-height: 3.5rem; white-space: pre-wrap; }
  input { width: 100%; padding: 0.4rem; margin-top: 0.25rem; }
  label { font-size: 0.85rem; opacity: 0.8; }
  .note { font-size: 0.85rem; opacity: 0.75; }
</style>
</head>
<body>
<h1>cf-containers — musevm-kernel-worker</h1>

<h2>HTTPS ヘルスチェック</h2>
<p class="note">このページと同じオリジンの /health を HTTPS で叩き、ステータスと応答時間を表示する。</p>
<div class="row">
  <button id="hc-btn">再チェック</button>
</div>
<pre id="out-hc">…</pre>

<h2>コンテナ本体</h2>
<div class="row">
  <button id="btn-start" data-confirm="コンテナを起動" data-call="POST /cf-containers/start #out-main">起動</button>
  <button id="btn-stop" data-confirm="コンテナを停止" data-call="POST /cf-containers/stop #out-main">停止</button>
  <button id="btn-restart" data-confirm="コンテナを再起動" data-call="POST /cf-containers/restart #out-main">再起動</button>
  <button data-call="POST /cf-containers/status #out-main">状態を更新</button>
</div>
<pre id="out-main">…</pre>

<h2>カーネル成果物</h2>
<p class="note">イメージに組み込まれた最小化カーネル（bzImage）の状態。サイズと SHA-256（SHA256SUMS との照合結果）を表示する。</p>
<div class="row">
  <button data-call="GET /cf-containers/agent/status #out-kernel">状態を取得</button>
</div>
<pre id="out-kernel">…</pre>

<h2>ブートテスト（QEMU）</h2>
<p class="note">bzImage を QEMU（TCG エミュレーション）で起動し、シリアル出力を確認する。イメージ内にルートファイルシステムは無いため、正常なカーネルは VFS のルートマウントで panic して止まる。その panic に到達することが成功の目印（最大90秒）。</p>
<div class="row">
  <button data-confirm="ブートテストを実行" data-call="POST /cf-containers/agent/kernel/boot-test #out-boot">ブートテストを実行</button>
</div>
<pre id="out-boot">…</pre>

<h2>システム（コンテナ内）</h2>
<p class="note">uptime・ロードアベレージ・メモリ（free相当）・ディスク（df相当、ルートFS）。</p>
<div class="row">
  <button data-call="GET /cf-containers/agent/status #out-sys">状態を取得</button>
</div>
<pre id="out-sys">…</pre>

<div id="modal" class="modal-overlay" hidden>
  <div class="modal-box">
    <p id="modal-msg"></p>
    <div class="row">
      <button id="modal-yes">はい</button>
      <button id="modal-no">いいえ</button>
    </div>
  </div>
</div>

<label>CONTROL_TOKEN（署名鍵・ブラウザ内でのみ使用し、送信されません）
  <input id="token" type="password" autocomplete="off">
</label>

<script>
  async function authHeaders(method, path) {
    const secret = document.getElementById('token').value;
    if (!secret) return {};
    const ts = String(Math.floor(Date.now() / 1000));
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(method + '\\n' + path + '\\n' + ts));
    const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
    return { 'X-Timestamp': ts, 'X-Signature': hex };
  }
  async function call(spec) {
    const [method, path, outSel] = spec.split(' ');
    const out = document.querySelector(outSel);
    const headers = await authHeaders(method, path);
    out.textContent = method + ' ' + path + ' …';
    try {
      const res = await fetch(path, { method, headers });
      out.textContent = 'HTTP ' + res.status + '\\n' + await res.text();
    } catch (e) {
      out.textContent = String(e);
    }
  }
  function confirmModal(label) {
    return new Promise((resolve) => {
      const modal = document.getElementById('modal');
      document.getElementById('modal-msg').textContent = label + 'しますか？';
      modal.hidden = false;
      const yes = document.getElementById('modal-yes');
      const no = document.getElementById('modal-no');
      const cleanup = () => {
        yes.removeEventListener('click', onYes);
        no.removeEventListener('click', onNo);
      };
      const onYes = () => { modal.hidden = true; cleanup(); resolve(true); };
      const onNo = () => { modal.hidden = true; cleanup(); resolve(false); };
      yes.addEventListener('click', onYes);
      no.addEventListener('click', onNo);
    });
  }
  function setPair(start, stop, status) {
    if (!start || !stop) return;
    start.classList.remove('btn-green', 'btn-fill-green');
    stop.classList.remove('btn-yellow');
    start.disabled = false; stop.disabled = false;
    if (status === 'running' || status === 'healthy') {
      start.classList.add('btn-fill-green');
      start.disabled = true;
      stop.classList.add('btn-yellow');
    } else if (status === 'stopped') {
      start.classList.add('btn-green');
      stop.disabled = true;
    }
  }
  function applyContainerState(status) {
    const start = document.getElementById('btn-start');
    const stop = document.getElementById('btn-stop');
    const restart = document.getElementById('btn-restart');
    setPair(start, stop, status);
    if (restart) restart.disabled = (status === 'stopped');
  }
  const mainOut = document.getElementById('out-main');
  new MutationObserver(() => {
    const m = /"status"\\s*:\\s*"([a-z_]+)"/.exec(mainOut.textContent || '');
    if (m) applyContainerState(m[1]);
  }).observe(mainOut, { childList: true, characterData: true, subtree: true });
  for (const btn of document.querySelectorAll('button[data-call]')) {
    btn.addEventListener('click', async () => {
      const label = btn.dataset.confirm;
      if (label) {
        const ok = await confirmModal(label);
        if (!ok) {
          const outSel = btn.dataset.call.split(' ')[2];
          const out = outSel ? document.querySelector(outSel) : null;
          if (out) out.textContent = 'キャンセルしました';
          return;
        }
      }
      await call(btn.dataset.call);
    });
  }
  async function health() {
    const out = document.getElementById('out-hc');
    const url = location.origin + '/health';
    const t0 = performance.now();
    try {
      const res = await fetch(url);
      const ms = Math.round(performance.now() - t0);
      out.textContent = 'GET ' + url + '\\nHTTP ' + res.status + ' (' + ms + ' ms)\\nbody: ' + (await res.text()).trim();
    } catch (e) {
      out.textContent = 'GET ' + url + '\\nerror: ' + String(e);
    }
  }
  document.getElementById('hc-btn').addEventListener('click', health);
  health();
  call('POST /cf-containers/status #out-main');
  call('GET /cf-containers/agent/status #out-kernel');
</script>
</body>
</html>
`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return new Response("ok\n", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (url.pathname === "/cf-containers") {
      return new Response(CONTROL_PAGE, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (url.pathname.startsWith("/cf-containers/")) {
      if (env.CONTROL_TOKEN) {
        const ts = request.headers.get("X-Timestamp");
        const sigHex = request.headers.get("X-Signature");
        let ok = false;
        if (ts && sigHex && /^[0-9a-f]{64}$/.test(sigHex)) {
          const now = Math.floor(Date.now() / 1000);
          if (Math.abs(now - Number(ts)) <= 300) {
            const enc = new TextEncoder();
            const key = await crypto.subtle.importKey(
              "raw", enc.encode(env.CONTROL_TOKEN),
              { name: "HMAC", hash: "SHA-256" }, false, ["verify"],
            );
            const sig = new Uint8Array(
              sigHex.match(/../g)!.map((h) => parseInt(h, 16)),
            );
            ok = await crypto.subtle.verify(
              "HMAC", key, sig,
              enc.encode(`${request.method}\n${url.pathname}\n${ts}`),
            );
          }
        }
        if (!ok) {
          return new Response("unauthorized\n", { status: 401 });
        }
      }
      const stub = getContainer(env.KERNEL_CONTAINER, INSTANCE);
      const action = url.pathname.slice("/cf-containers/".length);

      // In-container agent API: forward verbatim — but only while the
      // instance is up. Fetching the stub would otherwise (re)start the
      // instance, which silently undoes an explicit stop: the control
      // page's own status refreshes kept waking the container back up.
      // The lifecycle panel is the one place that starts it.
      if (action.startsWith("agent/")) {
        const st = (await stub.containerState()) as { status?: string } | null;
        if (st && st.status === "stopped") {
          return Response.json(
            { error: "container is stopped", hint: "start it from the container panel first" },
            { status: 503 },
          );
        }
        const target = new URL(request.url);
        target.pathname = "/" + action;
        return stub.fetch(new Request(target.toString(), request));
      }

      try {
        let state: unknown;
        switch (action) {
          case "start":
            state = await stub.startContainer();
            break;
          case "stop":
            state = await stub.stopContainer();
            break;
          case "restart":
            state = await stub.restartContainer();
            break;
          case "status":
            state = await stub.containerState();
            break;
          default:
            return new Response("unknown action\n", { status: 404 });
        }
        return Response.json({ action, state });
      } catch (err) {
        return Response.json(
          { action, error: err instanceof Error ? err.message : String(err) },
          { status: 500 },
        );
      }
    }

    const container = getContainer(env.KERNEL_CONTAINER, INSTANCE);
    return container.fetch(request);
  },
};
