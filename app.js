const editor = document.getElementById('editor');
const preview = document.getElementById('preview');
const wordCount = document.getElementById('word-count');
const charCount = document.getElementById('char-count');
const saveStatus = document.getElementById('save-status');

let isMarkdownMode = false;
let autoSaveTimeout;

// Load document data from LocalStorage instantly on app startup
window.addEventListener('DOMContentLoaded', () => {
    const savedContent = localStorage.getItem('notepad_online_content');
    if (savedContent) {
        editor.innerHTML = savedContent;
        updateMetrics();
    }
});

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

// Multi-event update listener (Input changes + triggers debounce backup)
editor.addEventListener('input', () => {
    updateMetrics();
    triggerAutoSave();
    if (isMarkdownMode) renderMarkdown();
});

function updateMetrics() {
    const text = editor.innerText.trim();
    const words = text === '' ? 0 : text.split(/\s+/).length;
    const chars = editor.innerText.length;
    wordCount.textContent = `Words: ${words}`;
    charCount.textContent = `Characters: ${chars}`;
}

// Debounced auto-save function (Saves 1 second after typing stops)
function triggerAutoSave() {
    saveStatus.textContent = "✍️ Typing...";
    saveStatus.style.color = "#888";
    clearTimeout(autoSaveTimeout);
    autoSaveTimeout = setTimeout(() => {
        localStorage.setItem('notepad_online_content', editor.innerHTML);
        saveStatus.textContent = "💾 Auto-saved";
        saveStatus.style.color = "#28a745";
    }, 1000);
}

function toggleDarkMode() {
    document.body.classList.toggle('dark-mode');
    const btn = document.getElementById('dark-btn');
    btn.textContent = document.body.classList.contains('dark-mode') ? "☀️ Light Mode" : "🌙 Dark Mode";
}

// Side-by-Side Markdown Panel System Toggle
function toggleMarkdown() {
    isMarkdownMode = !isMarkdownMode;
    const btn = document.getElementById('md-btn');
    if (isMarkdownMode) {
        preview.classList.remove('hidden');
        btn.textContent = "📝 Hide Preview";
        renderMarkdown();
    } else {
        preview.classList.add('hidden');
        btn.textContent = "📝 Show Markdown";
    }
}

// Simple, regex-powered native Markdown text parser
function renderMarkdown() {
    let rawText = editor.innerText;
    
    // Escape standard layout components
    let html = rawText
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        // Headings (# Header)
        .replace(/^### (.*$)/gim, '<h3>$1</h3>')
        .replace(/^## (.*$)/gim, '<h2>$1</h2>')
        .replace(/^# (.*$)/gim, '<h1>$1</h1>')
        // Bold (**text**)
        .replace(/\*\*(.*)\*\*/gim, '<b>$1</b>')
        // Italics (*text*)
        .replace(/\*(.*)\*/gim, '<i>$1</i>')
        // Inline code blocks (`code`)
        .replace(/`(.*?)`/gim, '<code>$1</code>')
        // Unordered List line match (- list item)
        .replace(/^\- (.*$)/gim, '<ul><li>$1</li></ul>')
        // Cleanup nested layout list tags 
        .replace(/<\/ul>\s*<ul>/gim, '')
        // Formatting paragraphs with clean linebreaks
        .replace(/\n$/gim, '<br>')
        .replace(/\n/gim, '<br>');

    preview.innerHTML = html;
}

function speakText() {
    const text = editor.innerText;
    if (!text.trim()) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    window.speechSynthesis.speak(utterance);
}

function printDoc() {
    window.print();
}

function findAndReplace() {
    const findText = document.getElementById('find-input').value;
    const replaceText = document.getElementById('replace-input').value;
    if (!findText) return alert("Enter text to find.");
    
    const regex = new RegExp(findText, 'g');
    const currentHTML = editor.innerHTML;
    if (!currentHTML.includes(findText)) return alert("Text phrase not found.");
    
    editor.innerHTML = currentHTML.replace(regex, replaceText);
    updateMetrics();
    triggerAutoSave();
}

function clearDoc() {
    if (confirm("Are you sure you want to permanently clear this document?")) {
        editor.innerHTML = "";
        localStorage.removeItem('notepad_online_content');
        updateMetrics();
        saveStatus.textContent = "🗑️ Cleared";
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
