const editor = document.getElementById('editor');
const preview = document.getElementById('preview');
const wordCount = document.getElementById('word-count');
const charCount = document.getElementById('char-count');
const saveStatus = document.getElementById('save-status');
const workspaceOuter = document.getElementById('workspace-outer');
const goalContainer = document.getElementById('goal-progress-container');
const goalBar = document.getElementById('goal-progress-bar');
const goalStatus = document.getElementById('goal-status');
const goalInput = document.getElementById('word-goal-input');
const tableGridMenu = document.getElementById('table-grid-menu');
const gridMatrix = document.getElementById('grid-matrix');
const gridLabel = document.getElementById('grid-label');

let isMarkdownMode = false;
let autoSaveTimeout;
const MAX_ROWS = 5;
const MAX_COLS = 5;

// Core initialization layer
window.addEventListener('DOMContentLoaded', () => {
    const savedContent = localStorage.getItem('notepad_online_content');
    if (savedContent) {
        editor.innerHTML = savedContent;
    }
    
    const savedGoal = localStorage.getItem('notepad_online_goal');
    if (savedGoal) {
        goalInput.value = savedGoal;
    }

    updateMetrics();
    buildInteractiveTableGrid();
});

function format(command, value = null) {
    document.execCommand(command, false, value);
    editor.focus();
}

function changeFontSize(action) {
    const currentSize = window.getComputedStyle(editor).fontSize;
    let newSize = parseFloat(currentSize);
    if (action === 'increase') newSize += 2;
    if (action === 'decrease' && newSize > 10) newSize -= 2;
    editor.style.fontSize = newSize + 'px';
}

function changeFontFamily(font) {
    editor.style.fontFamily = font;
}

function changeTextColor(color) {
    format('foreColor', color);
}

function changeHighlightColor(color) {
    format('hiliteColor', color);
}

function changeLayoutView(view) {
    if (view === 'page') {
        workspaceOuter.classList.remove('bg-notepad');
        workspaceOuter.classList.add('bg-page');
    } else {
        workspaceOuter.classList.remove('bg-page');
        workspaceOuter.classList.add('bg-notepad');
    }
}

// Interactive Table Builder Logic
function buildInteractiveTableGrid() {
    gridMatrix.innerHTML = '';
    for (let r = 1; r <= MAX_ROWS; r++) {
        for (let c = 1; c <= MAX_COLS; c++) {
            const cell = document.createElement('div');
            cell.classList.add('grid-cell');
            cell.dataset.row = r;
            cell.dataset.col = c;
            
            // Hover matrix mapping event tracking
            cell.addEventListener('mouseover', () => highlightGridCells(r, c));
            cell.addEventListener('click', () => insertTableFromGrid(r, c));
            
            gridMatrix.appendChild(cell);
        }
    }
}

function toggleTableGridMenu() {
    tableGridMenu.classList.toggle('hidden');
}

function highlightGridCells(targetRows, targetCols) {
    gridLabel.textContent = `${targetRows} x ${targetCols} Table`;
    const cells = gridMatrix.querySelectorAll('.grid-cell');
    cells.forEach(cell => {
        const r = parseInt(cell.dataset.row);
        const c = parseInt(cell.dataset.col);
        if (r <= targetRows && c <= targetCols) {
            cell.classList.add('active');
        } else {
            cell.classList.remove('active');
        }
    });
}

function insertTableFromGrid(rows, cols) {
    let tableHtml = '<table>';
    for (let i = 0; i < rows; i++) {
        tableHtml += '<tr>';
        for (let j = 0; j < cols; j++) {
            // First row acts as standard bold structural headers
            if (i === 0) {
                tableHtml += '<th>Header</th>';
            } else {
                tableHtml += '<td>Cell</td>';
            }
        }
        tableHtml += '</tr>';
    }
    tableHtml += '</table><p><br></p>'; // trailing paragraph ensures cursor can escape table layout below
    
    format('insertHTML', tableHtml);
    tableGridMenu.classList.add('hidden');
}

// Close float screens cleanly if clicked outside selection boxes
window.addEventListener('click', (e) => {
    if (!e.target.matches('#table-btn') && !e.target.closest('#table-grid-menu')) {
        tableGridMenu.classList.add('hidden');
    }
});

// Core text metrics calculations & tracker algorithms
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

    const goal = parseInt(goalInput.value);
    if (goal > 0) {
        localStorage.setItem('notepad_online_goal', goal);
        goalContainer.classList.remove('hidden');
        const percentage = Math.min((words / goal) * 100, 100);
        goalBar.style.width = `${percentage}%`;
        
        if (percentage >= 100) {
            goalStatus.textContent = "🏆 Goal Met!";
            goalBar.style.backgroundColor = "#28a745";
        } else {
            goalStatus.textContent = `${Math.round(percentage)}% of Goal`;
            goalBar.style.backgroundColor = "#007bff";
        }
    } else {
        localStorage.removeItem('notepad_online_goal');
        goalContainer.classList.add('hidden');
        goalStatus.textContent = "";
    }
}

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

function renderMarkdown() {
    let rawText = editor.innerText;
    let html = rawText
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/^### (.*$)/gim, '<h3>$1</h3>')
        .replace(/^## (.*$)/gim, '<h2>$1</h2>')
        .replace(/^# (.*$)/gim, '<h1>$1</h1>')
        .replace(/\*\*(.*)\*\*/gim, '<b>$1</b>')
        .replace(/\*(.*)\*/gim, '<i>$1</i>')
        .replace(/`(.*?)`/gim, '<code>$1</code>')
        .replace(/^\- (.*$)/gim, '<ul><li>$1</li></ul>')
        .replace(/<\/ul>\s*<ul>/gim, '')
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
