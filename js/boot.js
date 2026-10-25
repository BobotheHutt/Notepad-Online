// Apply the saved theme before first paint so there is no flash. (A file of
// its own, not inline: the security policy allows only the app's own scripts.)
try { var s = JSON.parse(localStorage.getItem('np.settings') || '{}'); if (s.theme) document.documentElement.dataset.theme = s.theme; } catch (e) {}
