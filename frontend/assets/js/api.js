export function createApi() {
  let token = '';
  return {
    async request(path, body) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), path === 'connect' ? 45000 : 20000);
      try {
        const response = await fetch('/api/' + path, {method: body === undefined ? 'GET' : 'POST',
          headers: {'Content-Type': 'application/json', 'X-Debug-Token': token},
          body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal});
        let data;
        try { data = await response.json(); } catch (_) { throw Error('本地服务未就绪，请通过 start_debugger.cmd 启动。'); }
        if (!response.ok) throw Error(data.error || '操作失败');
        if (path === 'status') token = data.token;
        return data;
      } catch (error) {
        if (error.name === 'AbortError') throw Error('连接超时，请检查本地服务与 OpenOCD。');
        throw error;
      } finally { clearTimeout(timer); }
    }
  };
}

export function download(text, filename, type) {
  const url = URL.createObjectURL(new Blob([text], {type}));
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const number = value => Number.isFinite(value) ? Number(value).toLocaleString('en-US', {maximumFractionDigits: 5, useGrouping: false}) : '—';
export const palette = ['#287c64', '#6890b8', '#bd9148', '#9a78af', '#c37866', '#5d959d', '#a98f6b', '#809c60'];
export function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
