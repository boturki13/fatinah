'use strict';

(() => {
  const supportedLanguages = new Set(['ar', 'en']);

  function setLanguage(language) {
    if (!supportedLanguages.has(language)) return;
    document.getElementById('lang-ar').hidden = language !== 'ar';
    document.getElementById('lang-en').hidden = language !== 'en';
    for (const button of document.querySelectorAll('[data-language]')) {
      const selected = button.dataset.language === language;
      button.classList.toggle('on', selected);
      button.setAttribute('aria-pressed', selected ? 'true' : 'false');
    }
    document.documentElement.lang = language;
    document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
  }

  for (const button of document.querySelectorAll('[data-language]')) {
    button.addEventListener('click', () => setLanguage(button.dataset.language));
  }
})();
