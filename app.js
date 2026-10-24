const editor = document.getElementById('editor');
const wordCount = document.getElementById('word-count');
const charCount = document.getElementById('char-count');

// Execute rich text commands natively
function format(command) {
    document.execCommand(command, false, null);
    editor.focus();
}

// Adjust font size dynamically
function changeFontSize(action) {
    const currentSize = window.getComputedStyle(editor).fontSize;
    let newSize = parseFloat(currentSize);
    
    if (action === 'increase') newSize += 2;
    if (action === 'decrease' && newSize > 10) newSize -= 2;
    
    editor.style.fontSize = newSize + 'px';
}

// Track text metrics in real-time
editor.addEventListener('input', () => {
    const text = editor.innerText.trim();
    
    // Exact word counting logic
    const words = text === '' ? 0 : text.split(/\s+/).length;
    const chars = editor.innerText.length;

    wordCount.textContent = `Words: ${words}`;
    charCount.textContent = `Characters: ${chars}`;
});

// Text-to-Speech engine
function speakText() {
    const text = editor.innerText;
    if (!text.trim()) return alert("Nothing to read aloud!");
    
    // Stop any active readings first
    window.speechSynthesis.cancel();
    
    const utterance = new SpeechSynthesisUtterance(text);
    window.speechSynthesis.speak(utterance);
}

// File export functionality
function saveFile(type) {
    let content = "";
    let filename = "document";
    let mimeType = "";

    if (type === 'txt') {
        content = editor.innerText; // Plain layout text
        filename += ".txt";
        mimeType = "text/plain";
    } else if (type === 'html') {
        content = editor.innerHTML; // Keeps formatting HTML tags
        filename += ".html";
        mimeType = "text/html";
    }

    const blob = new Blob([content], { type: mimeType });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    URL.revokeObjectURL(link.href);
}
