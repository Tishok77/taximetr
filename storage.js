// Простое хранилище поверх localStorage.
// Ключи:
//  - taximetr_current_shift : активная (незавершённая) смена или отсутствует
//  - taximetr_history       : массив завершённых смен
//  - taximetr_sheets_url    : ссылка на Google Apps Script Web App для выгрузки

const AppStorage = (() => {
  const KEY_CURRENT = 'taximetr_current_shift';
  const KEY_HISTORY = 'taximetr_history';
  const KEY_SHEETS_URL = 'taximetr_sheets_url';

  function getCurrentShift() {
    const raw = localStorage.getItem(KEY_CURRENT);
    return raw ? JSON.parse(raw) : null;
  }

  function saveCurrentShift(shift) {
    localStorage.setItem(KEY_CURRENT, JSON.stringify(shift));
  }

  function clearCurrentShift() {
    localStorage.removeItem(KEY_CURRENT);
  }

  function getHistory() {
    const raw = localStorage.getItem(KEY_HISTORY);
    return raw ? JSON.parse(raw) : [];
  }

  function addToHistory(shift) {
    const history = getHistory();
    history.unshift(shift);
    localStorage.setItem(KEY_HISTORY, JSON.stringify(history));
  }

  function saveHistory(history) {
    localStorage.setItem(KEY_HISTORY, JSON.stringify(history));
  }

  function getSheetsUrl() {
    return localStorage.getItem(KEY_SHEETS_URL) || '';
  }

  function saveSheetsUrl(url) {
    localStorage.setItem(KEY_SHEETS_URL, url);
  }

  return {
    getCurrentShift, saveCurrentShift, clearCurrentShift,
    getHistory, addToHistory, saveHistory,
    getSheetsUrl, saveSheetsUrl,
  };
})();
