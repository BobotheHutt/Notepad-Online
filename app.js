const editor = document.getElementById('editor');
const wordCount = document.getElementById('word-count');
const charCount = document.getElementById('char-count');

function format(command) {
    document.execCommand(command, false, null);
    editor.focus();
}

function changeFontSize(action) {
    const currentSize = window.getComputedStyle(editor).fontSize;
    let newSize = parseFloat(currentSize);
    if (action === 'increase') newSize += 2;
    if (action === 'decrease' && newSize > 10) newSize -= 2;
    editor.style.fontSize = newSize + 'px';
}

// Live analytics metrics
editor.addEventListener('input', updateMetrics);
function updateMetrics() {
    const text = editor.innerText.trim();
    const words = text === '' ? 0 : text.split(/\s+/).length;
    const chars = editor.innerText.length;
    wordCount.textContent = `Words: ${words}`;
    charCount.textContent = `Characters: ${chars}`;
}

// Global Dark Mode Toggle State
function toggleDarkMode() {
    document.body.classList.toggle('dark-mode');
    const btn = document.getElementById('dark-btn');
    if(document.body.classList.contains('dark-mode')) {
        btn.textContent = "☀️ Light Mode";
    } else {
        btn.textContent = "🌙 Dark Mode";
    }
}

// Direct Text-To-Speech Proofreader
function speakText() {
    const text = editor.innerText;
    if (!text.trim()) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    window.speechSynthesis.speak(utterance);
}

// Native Local Web Printing Window Access
function printDoc() {
    window.print();
}

// Inline Text Find and Global HTML Substitution
function findAndReplace() {
    const findText = document.getElementById('find-input').value;
    const replaceText = document.getElementById('replace-input').value;
    
    if (!findText) return alert("Enter text to find.");
    
    // Global regular expression match
    const regex = new RegExp(findText, 'g');
    const currentHTML = editor.innerHTML;
    
    if (!currentHTML.includes(findText)) {
        return alert("Text variant matching phrase not found.");
    }
    
    editor.innerHTML = currentHTML.replace(regex, replaceText);
    updateMetrics();
}

function clearDoc() {
    if (confirm("Are you sure you want to permanently delete this layout content?")) {
        editor.innerHTML = "";
        updateMetrics();
    }
}

function saveFile(type) {
    let content = type === 'txt' ? editor.innerText : editor.innerHTML;
    let filename = `document.${type}`;
    let mimeType = type === 'txt' ? "text/plain" : "text/html";

    const blob = new Blob([content], { type: mimeType });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    URL.revokeObjectURL(link.href);
}
