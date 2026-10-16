const providers = document.querySelector('#providers');
const error = document.querySelector('#error');
try {
  const config = await fetch('/api/config', { cache: 'no-store' }).then(response => response.json());
  providers.replaceChildren();
  if (config.google) {
    const link = document.createElement('a'); link.className = 'provider google'; link.href = '/auth/google/start'; link.textContent = 'Продолжить с Google'; providers.append(link);
  }
  if (config.telegram) {
    const setup = await fetch('/auth/telegram/setup', { cache: 'no-store' }).then(response => response.json());
    const slot = document.createElement('div'); slot.className = 'telegram-slot'; providers.append(slot);
    const script = document.createElement('script'); script.src = 'https://telegram.org/js/telegram-widget.js?22';
    script.async = true; script.dataset.telegramLogin = setup.bot; script.dataset.size = 'large'; script.dataset.authUrl = setup.url;
    slot.append(script);
    const miniScript = document.createElement('script'); miniScript.src = 'https://telegram.org/js/telegram-web-app.js';
    miniScript.onload = async () => {
      const initData = window.Telegram?.WebApp?.initData;
      if (!initData) return;
      window.Telegram.WebApp.ready();
      try {
        const result = await fetch('/auth/telegram/mini', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initData }) });
        const payload = await result.json();
        if (!result.ok) throw new Error(payload.error || 'Не удалось войти через Telegram');
        location.replace(payload.next || '/');
      } catch (problem) { error.textContent = problem.message; }
    };
    document.head.append(miniScript);
  }
  if (!config.google && !config.telegram) error.textContent = 'Вход ещё не настроен владельцем сервера.';
} catch (problem) { error.textContent = problem.message; }
