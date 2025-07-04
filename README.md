# VS Code AI Coding Copilot Extension

A modern, privacy-friendly AI coding assistant for VS Code, featuring:
- **Chat-based AI help** (powered by Groq Llama 3)
- **Retrieval-Augmented Generation (RAG)** using your own files/snippets
- **File upload** for any text/code/documents
- **Local embeddings** with Hugging Face models (no cloud embedding costs)
- **Paste code snippet** for instant RAG

---

## Features

- 💬 **Chat UI**: Ask coding questions, get answers, and code completions in a beautiful sidebar chat.
- 📄 **File Upload**: Upload any text file (code, docs, notes, etc.) and ask questions about its content.
- 🧩 **Paste Snippet**: Paste multi-line code snippets for RAG-powered Q&A.
- 🧠 **Local Embeddings**: Uses a local FastAPI server with Hugging Face sentence-transformers for privacy and speed.
- 🔍 **Context-Aware Answers**: AI uses only your uploaded files/snippets for RAG questions.
- 🌐 **Groq LLM Integration**: Fast, accurate answers from Llama 3 via Groq API.

---

## Setup

### 1. Clone the Repository
```sh
git clone https://github.com/yourusername/my-coding-extension.git
cd my-coding-extension
```

### 2. Install Dependencies
```sh
npm install
```

### 3. Configure Your API Key
- Copy `.env.example` to `.env` (or create `.env` in the project root):
  ```
  GROQ_API_KEY=sk-...
  ```
- **Never commit your `.env` file!** (It is in `.gitignore` by default.)

### 4. Start the Local Embedding Server
- Go to `local-embeddings-server/` and start the FastAPI server:
  ```sh
  cd local-embeddings-server
  venv\Scripts\activate  # (Windows) or source venv/bin/activate (Linux/macOS)
  python server.py
  ```
- The server should run at `http://127.0.0.1:8000`.

### 5. Run/Debug the Extension
- Open the project in VS Code.
- Press `F5` to launch the extension in a new Extension Development Host window.

---

## Usage
- Open the AI Copilot chat from the sidebar.
- Upload files or paste code snippets for RAG.
- Ask questions about your code, docs, or any uploaded content.
- For normal coding questions, just chat—no file upload needed!

---

## Security & Privacy
- Your `.env` file is **never** committed to git.
- All embeddings for RAG are generated locally—no code or docs are sent to the cloud.
- Only your questions are sent to Groq for LLM answers.

---

## Author
**Viraj Gupta**

---

## License
[MIT](LICENSE) (or your preferred license)
