const error = document.querySelector('#error');
const button = document.querySelector('#approve');
try {
  const result = await fetch('/api/device/info').then(response => response.json());
  if (!result.code) throw new Error('Код подключения истёк. Вернитесь в приложение и начните заново.');
  document.querySelector('#code').textContent = result.code;
  button.onclick = async () => {
    button.disabled = true;
    try {
      const response = await fetch('/api/device/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (!response.ok) throw new Error((await response.json()).error || 'Не удалось подключить');
      document.querySelector('.intro').textContent = 'Готово. Вернитесь в LoKan на компьютере.';
      button.remove();
    } catch (problem) { error.textContent = problem.message; button.disabled = false; }
  };
} catch (problem) { error.textContent = problem.message; button.disabled = true; }
