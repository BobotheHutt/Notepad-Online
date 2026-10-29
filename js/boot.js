// Apply the saved theme before first paint so there is no flash. (A file of
// its own, not inline: the security policy allows only the app's own scripts.)
// The release (index.html loads each of the app's files as file.js?v=N, so
// a release is a new address that no cache on the way can serve an old copy
// of): the app's later loads carry it too.
window.NP_V = (document.currentScript && document.currentScript.src.split('?')[1]) || '';
try { var s = JSON.parse(localStorage.getItem('np.settings') || '{}'); if (s.theme) document.documentElement.dataset.theme = s.theme; } catch (e) {}
