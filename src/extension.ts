// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import axios from 'axios';
import { ChatGroq } from "@langchain/groq";
import { Chroma } from "langchain/vectorstores/chroma";
// import { RetrievalQAChain } from "langchain/chains";
import { MemoryVectorStore } from "langchain/vectorstores/memory";
// import { createRetrievalChain } from "langchain/chains/retrieval";
// import { ChatPromptTemplate } from "@langchain/core/prompts";
// import { MessagesPlaceholder } from "@langchain/core/prompts";
// import { createStuffDocumentsChain } from "langchain/chains/combine_documents";
import { BaseMessage } from "@langchain/core/messages";
import { QdrantClient } from "@qdrant/js-client-rest";

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
let currentPanel: vscode.WebviewPanel | undefined;

// Initialize Qdrant client
const qdrant = new QdrantClient({ url: "http://localhost:6333" });
const QDRANT_COLLECTION = "file_chunks_v2";

// Store chat history for the current session
let chatHistory: { role: 'user' | 'ai' | 'error'; text: string }[] = [];

// Restore chat history from globalState if available
const savedHistory = vscode.workspace.getConfiguration().get<{ role: 'user' | 'ai' | 'error'; text: string }[]>('chatHistory');
if (savedHistory) {
	chatHistory = savedHistory;
}

// Qdrant client setup
async function ensureQdrantCollection() {
	const collections = await qdrant.getCollections();
	if (!collections.collections.some((c: any) => c.name === QDRANT_COLLECTION)) {
		await qdrant.createCollection(QDRANT_COLLECTION, {
			vectors: { size: 384, distance: "Cosine" }, // 384 for MiniLM embeddings
		});
	}
}

// Helper: Get embedding from local FastAPI server
async function getLocalEmbedding(text: string): Promise<number[]> {
	const response = await axios.post(
		"http://127.0.0.1:8000/embed",
		{ inputs: text },
		{ headers: { "Content-Type": "application/json" } }
	);
	return response.data.embedding;
}

// Chunk a file's content into ~500 character chunks, breaking at newlines if possible
function chunkFileContent(content: string, chunkSize = 500): string[] {
	const lines = content.split('\n');
	const chunks: string[] = [];
	let currentChunk = '';
	for (const line of lines) {
		if ((currentChunk + line + '\n').length > chunkSize) {
			if (currentChunk) chunks.push(currentChunk);
			currentChunk = '';
		}
		currentChunk += line + '\n';
	}
	if (currentChunk) chunks.push(currentChunk);
	return chunks;
}

// Upload file handler: chunk, embed, and store in Qdrant
async function storeFileChunksInQdrant(fileName: string, content: string) {
	await ensureQdrantCollection();
	const chunks = chunkFileContent(content);
	for (const chunk of chunks) {
		const embedding = await getLocalEmbedding(chunk);
		console.log('Embedding length:', embedding.length, 'First 5:', embedding.slice(0, 5));
		const upsertPayload = {
			points: [
				{
					id: Math.floor(Math.random() * 1e12),
					vector: embedding,
					payload: { chunk },
				},
			],
		};
		console.log('Qdrant upsert payload:', JSON.stringify(upsertPayload, null, 2));
		await qdrant.upsert(QDRANT_COLLECTION, upsertPayload);
	}
}

// Retrieve top-N most relevant chunks for a question using Qdrant
async function retrieveRelevantChunks(question: string, topN = 3): Promise<string[]> {
	await ensureQdrantCollection();
	const embedding = await getLocalEmbedding(question);
	const search = await qdrant.search(QDRANT_COLLECTION, {
		vector: embedding,
		limit: topN,
		with_payload: true,
	});
	return search.map((res: any) => res.payload.chunk);
}

function hasUploadedContext() {
	// Check if there are any points in Qdrant (uploaded files/snippets)
	// This is a simple async check for points count > 0
	return qdrant.count(QDRANT_COLLECTION, {}).then(res => res.count > 0).catch(() => false);
}

export function activate(context: vscode.ExtensionContext) {
	console.log('My Coding Extension ACTIVATED!');
	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "my-coding-extension" is now active!');

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	const helloWorldDisposable = vscode.commands.registerCommand('my-coding-extension.helloWorld', () => {
		// Display a message box to the user
		vscode.window.showInformationMessage('Hello World from My Coding Extension!');
	});

	const askAIDisposable = vscode.commands.registerCommand('my-coding-extension.askAI', async () => {
		if (currentPanel) {
			currentPanel.webview.html = getWebviewContent();
			attachMessageHandler(currentPanel, context);
			// Send chat history to webview after it loads
			setTimeout(() => {
				currentPanel?.webview.postMessage({ command: 'restoreHistory', history: chatHistory });
			}, 100);
			currentPanel.reveal();
		} else {
			currentPanel = vscode.window.createWebviewPanel(
				'askAI',
				'Ask AI',
				vscode.ViewColumn.One,
				{
					enableScripts: true
				}
			);
			currentPanel.webview.html = getWebviewContent();
			attachMessageHandler(currentPanel, context);
			// Send chat history to webview after it loads
			setTimeout(() => {
				currentPanel?.webview.postMessage({ command: 'restoreHistory', history: chatHistory });
			}, 100);
			currentPanel.onDidDispose(() => { currentPanel = undefined; });
		}
	});

	const triggerCompletionDisposable = vscode.commands.registerCommand('my-coding-extension.triggerCompletion', async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showInformationMessage('No active editor');
			return;
		}
		
		// Manually trigger completions at the current cursor position
		await vscode.commands.executeCommand('editor.action.triggerSuggest');
	});

	const provider = vscode.languages.registerCompletionItemProvider(
		{ scheme: 'file', language: '*' }, // All files
		{
			async provideCompletionItems(document, position, token, context) {
				console.log('AI completion provider called'); // Debug log
				try {
					// Get the last 20 lines before the cursor for context
					const startLine = Math.max(0, position.line - 19);
					const range = new vscode.Range(new vscode.Position(startLine, 0), position);
					const contextText = document.getText(range);

					if (contextText.trim().length < 3) {
						return [];
					}

					// Prompt for multi-line code continuation
					const aiSuggestion = await askGroq(
						`You are a coding assistant. Given the following code context, continue writing the next logical line(s) of code.\n\n` +
						`Return ONLY the code that should be inserted, with no explanations or markdown.\n` +
						`You may return multiple lines if appropriate.\n\n` +
						`Code context (up to the cursor):\n${contextText}\n\nContinue the code:`
					);

					// Clean up the AI response - remove any markdown or extra text
					let cleanSuggestion = aiSuggestion.trim();
					cleanSuggestion = cleanSuggestion.replace(/```[\w]*\n?/g, '').replace(/```/g, '');
					// Remove leading/trailing empty lines
					cleanSuggestion = cleanSuggestion.replace(/^\s+|\s+$/g, '');

					if (!cleanSuggestion || cleanSuggestion.length < 2) {
						console.log('AI returned empty or invalid suggestion');
						return [];
					}

					const completions: vscode.CompletionItem[] = [];
					const mainCompletion = new vscode.CompletionItem(
						cleanSuggestion,
						vscode.CompletionItemKind.Snippet
					);
					mainCompletion.detail = 'AI Suggestion';
					mainCompletion.documentation = 'AI-generated code continuation';
					mainCompletion.sortText = '00000';
					mainCompletion.insertText = cleanSuggestion;
					completions.push(mainCompletion);

					// Add some common completions as fallbacks
					const commonCompletions = ['length', 'toString()', 'valueOf()', 'constructor'];
					commonCompletions.forEach((item, index) => {
						const completion = new vscode.CompletionItem(
							item,
							vscode.CompletionItemKind.Property
						);
						completion.detail = 'Common';
						completion.sortText = `0000${index + 1}`;
						completions.push(completion);
					});

					console.log(`Returning ${completions.length} completion items`);
					return completions;
				} catch (error) {
					console.error('Error in completion provider:', error);
					return [];
				}
			}
		},
		'.', '(', ' ', '\n' // Trigger on dot, parenthesis, space, and newline
	);

	// Register a new command for pasting code snippets
	const pasteSnippetDisposable = vscode.commands.registerCommand('my-coding-extension.pasteSnippet', async () => {
		const snippet = await vscode.window.showInputBox({
			prompt: 'Paste your code snippet here',
			placeHolder: 'Paste code...'
		});
		if (!snippet || snippet.trim().length === 0) {
			vscode.window.showInformationMessage('No code snippet provided.');
			return;
		}
		// Chunk, embed, and store in Qdrant
		await ensureQdrantCollection();
		const chunks = chunkFileContent(snippet);
		for (const chunk of chunks) {
			const embedding = await getLocalEmbedding(chunk);
			console.log('Embedding length:', embedding.length, 'First 5:', embedding.slice(0, 5));
			const upsertPayload = {
				points: [
					{
						id: Math.floor(Math.random() * 1e12),
						vector: embedding,
						payload: { chunk },
					},
				],
			};
			console.log('Qdrant upsert payload:', JSON.stringify(upsertPayload, null, 2));
			await qdrant.upsert(QDRANT_COLLECTION, upsertPayload);
		}
		vscode.window.showInformationMessage('Snippet stored for RAG!');
	});

	context.subscriptions.push(helloWorldDisposable, askAIDisposable, triggerCompletionDisposable, provider, pasteSnippetDisposable);

	// After every update to chatHistory (after push in askGroq handler and error handler)
	context.globalState.update('chatHistory', chatHistory);
}

function attachMessageHandler(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
	console.log('[attachMessageHandler] called');
	panel.webview.onDidReceiveMessage(async (message) => {
		console.log('[webview message received]', message);
		if (message.command === 'askGroq') {
			const question = message.text;
			try {
				chatHistory.push({ role: 'user', text: question });
				await context.globalState.update('chatHistory', chatHistory);
				// Only try to retrieve context if there are uploaded files/snippets
				let relevantChunks: string[] = [];
				const hasContext = await hasUploadedContext();
				if (hasContext) {
					relevantChunks = await retrieveRelevantChunks(question, 3);
					console.log('Relevant chunks retrieved:', relevantChunks);
				}
				const summaryKeywords = ["summarize", "summary", "summarise", "give me a summary", "what is this file about", "explain this file"];
				const isSummaryRequest = summaryKeywords.some(kw => question.toLowerCase().includes(kw));
				let warning = '';
				let prompt = '';
				if (relevantChunks.length > 0) {
					if (isSummaryRequest) {
						try {
							await ensureQdrantCollection();
							const allPoints = await qdrant.scroll(QDRANT_COLLECTION, { limit: 1000, with_payload: true });
							const allChunks = allPoints.points.map((pt: any) => pt.payload.chunk);
							prompt = `You are a helpful AI coding assistant.\n` +
							  `The following is the content of a file the user uploaded. Summarize this file. ONLY use the content below. If you cannot, say 'I don't know based on the provided files.'\n\n` +
							  `File content:\n` +
							  allChunks.join('\n---\n') +
							  `\n\nUser question: ${question}\n\nAnswer:`;
						} catch (error) {
							console.error('Error retrieving all chunks for summary:', error);
							prompt = question;
						}
					} else {
						prompt = `You are a helpful AI coding assistant.\n` +
						  `You MUST ONLY use the following context from the user's uploaded files to answer the question.\n` +
						  `If the answer is not in the context, you MUST reply exactly: 'I don't know based on the provided files.'\n` +
						  `Do NOT use any outside knowledge. Do NOT elaborate or add information that is not present in the context.\n\n` +
						  `Context:\n` +
						  relevantChunks.join('\n---\n') +
						  `\n\nUser question: ${question}\n\nAnswer:`;
					}
				} else {
					prompt = question;
				}
				console.log('Prompt sent to AI:', prompt);
				const response = await askGroq(prompt);
				console.log('[askGroq handler] AI response:', response);
				if (typeof response !== 'string') {
					const errorMsg = 'AI response was not a string.';
					console.log('[askGroq handler] Error:', errorMsg, 'Actual response:', response);
					chatHistory.push({ role: 'error', text: errorMsg });
					await context.globalState.update('chatHistory', chatHistory);
					panel.webview.postMessage({ command: 'groqError', text: errorMsg });
				} else if (response.trim() === '') {
					const errorMsg = 'AI response was empty.';
					console.log('[askGroq handler] Error:', errorMsg);
					chatHistory.push({ role: 'error', text: errorMsg });
					await context.globalState.update('chatHistory', chatHistory);
					panel.webview.postMessage({ command: 'groqError', text: errorMsg });
				} else {
					// Add AI response to chat history
					chatHistory.push({ role: 'ai', text: response });
					await context.globalState.update('chatHistory', chatHistory);
					if (relevantChunks.length > 0) {
						// Check if the response contains any chunk or the required phrase
						const contextUsed = relevantChunks.some(chunk => response.includes(chunk.trim()));
						const saidIDontKnow = response.includes("I don't know based on the provided files.");
						if (!contextUsed && !saidIDontKnow) {
							warning = "Warning: The AI's answer may not be strictly based on your uploaded files.";
						}
					}
					if (warning) {
						console.log('[askGroq handler] Sending warning and response to webview');
						panel.webview.postMessage({ command: 'groqResponse', text: warning + '\n' + response });
					} else {
						console.log('[askGroq handler] Sending response to webview');
						panel.webview.postMessage({ command: 'groqResponse', text: response });
					}
				}
			} catch (err) {
				let errorMsg = 'Unknown error';
				if (err && typeof err === 'object' && 'message' in err) {
					errorMsg = (err as any).message;
				}
				// Add error to chat history
				chatHistory.push({ role: 'error', text: 'Error: ' + errorMsg });
				await context.globalState.update('chatHistory', chatHistory);
				panel.webview.postMessage({ command: 'groqError', text: 'Error: ' + errorMsg });
			}
		}
		else if (message.command === 'uploadFile') {
			// Process the uploaded file for RAG (chunk, embed, store in Qdrant)
			const { fileName, content } = message;
			await storeFileChunksInQdrant(fileName, content);
			vscode.window.showInformationMessage(`File uploaded: ${fileName} (stored for RAG)`);
		}
		else if (message.command === 'deleteFile') {
			const fileName = message.fileName;
			// Delete all chunks for this file from Qdrant
			await ensureQdrantCollection();
			await qdrant.delete(QDRANT_COLLECTION, {
				filter: { must: [{ key: 'fileName', match: { value: fileName } }] }
			});
			vscode.window.showInformationMessage(`File deleted: ${fileName}`);
		}
		else if (message.command === 'getUploadedFiles') {
			// Send current uploaded files to webview
			panel.webview.postMessage({ command: 'uploadedFiles', files: [] });
		}
		else if (message.command === 'pasteSnippet') {
			const snippet = message.snippet;
			if (!snippet || snippet.trim().length === 0) {
				vscode.window.showInformationMessage('No code snippet provided.');
				return;
			}
			// Chunk, embed, and store in Qdrant
			await ensureQdrantCollection();
			const chunks = chunkFileContent(snippet);
			for (const chunk of chunks) {
				const embedding = await getLocalEmbedding(chunk);
				console.log('Embedding length:', embedding.length, 'First 5:', embedding.slice(0, 5));
				const upsertPayload = {
					points: [
						{
							id: Math.floor(Math.random() * 1e12),
							vector: embedding,
							payload: { chunk },
						},
					],
				};
				console.log('Qdrant upsert payload:', JSON.stringify(upsertPayload, null, 2));
				await qdrant.upsert(QDRANT_COLLECTION, upsertPayload);
			}
			vscode.window.showInformationMessage('Snippet stored for RAG!');
		}
	});
}

// This method is called when your extension is deactivated
export function deactivate() {}

async function askGroq(question: string): Promise<string> {
	const apiKey = process.env.GROQ_API_KEY;
	const endpoint = 'https://api.groq.com/openai/v1/chat/completions';
	if (!apiKey) {
		console.log('[askGroq] Error: GROQ_API_KEY not set in environment');
		return 'Error: GROQ_API_KEY not set in environment';
	}
	try {
		console.log('[askGroq] Sending request to Groq...');
		const response = await axios.post(
			endpoint,
			{
				model: 'llama3-70b-8192',
				messages: [
					{ role: 'system', content: 'You are a helpful AI coding assistant.' },
					{ role: 'user', content: question }
				],
				max_tokens: 1024
			},
			{
				headers: {
					'Authorization': `Bearer ${apiKey}`,
					'Content-Type': 'application/json'
				},
				timeout: 10000 // 10 seconds
			}
		);
		console.log('[askGroq] Received response from Groq:', response.data);
		return response.data.choices[0].message.content.trim();
	} catch (err: any) {
		console.log('[askGroq] Error:', err);
		return 'Failed to get response from Groq: ' + (err.response?.data?.error?.message || err.message);
	}
}

function getWebviewContent(): string {
	return `
	<!DOCTYPE html>
	<html lang="en">
	<head>
		<meta charset="UTF-8">
		<title>Ask AI Chat</title>
		<style>
			body { font-family: Arial, sans-serif; background: #1e1e1e; color: #d4d4d4; margin: 0; padding: 0; }
			#container { display: flex; max-width: 900px; margin: 40px auto; background: #252526; border-radius: 8px; box-shadow: 0 2px 8px #0008; }
			#sidebar { width: 200px; background: #23272e; border-right: 1px solid #333; padding: 20px 0; border-radius: 8px 0 0 8px; display: flex; flex-direction: column; }
			#sidebar h3 { margin: 0 0 10px 20px; font-size: 1.1em; color: #b5cea8; }
			#newChatBtn { margin: 0 20px 10px 20px; background: #007acc; color: #fff; border: none; border-radius: 4px; padding: 6px 0; cursor: pointer; font-size: 0.95em; }
			#newChatBtn:hover { background: #005a9e; }
			#historyList { flex: 1; overflow-y: auto; margin: 0 0 10px 0; }
			.history-item { padding: 8px 20px; cursor: pointer; color: #d4d4d4; border-left: 3px solid transparent; }
			.history-item.selected { background: #333; border-left: 3px solid #007acc; }
			#clearHistoryBtn { margin: 10px 20px 0 20px; background: #a42626; color: #fff; border: none; border-radius: 4px; padding: 6px 0; cursor: pointer; font-size: 0.95em; }
			#clearHistoryBtn:hover { background: #d13438; }
			#main { flex: 1; padding: 20px; display: flex; flex-direction: column; }
			#chat { min-height: 120px; margin-bottom: 20px; flex: 1; overflow-y: auto; }
			.bubble { padding: 10px 14px; border-radius: 16px; margin-bottom: 10px; max-width: 80%; word-break: break-word; }
			.user { background: #007acc; color: #fff; margin-left: 20%; text-align: right; }
			.ai { background: #333; color: #d4d4d4; margin-right: 20%; text-align: left; }
			.error { background: #a42626; color: #fff; margin-right: 20%; text-align: left; border: 1px solid #d13438; }
			#inputRow { display: flex; align-items: center; }
			#userInput { flex: 1; font-size: 1rem; padding: 8px; border-radius: 4px; border: none; }
			#sendBtn { background: #007acc; color: white; cursor: pointer; font-size: 1rem; padding: 8px 16px; border-radius: 4px; border: none; margin-left: 8px; }
			#sendBtn:hover { background: #005a9e; }
			#spinner { display: none; margin-left: 10px; }
			.spinner { border: 4px solid #333; border-top: 4px solid #007acc; border-radius: 50%; width: 22px; height: 22px; animation: spin 1s linear infinite; display: inline-block; }
			@keyframes spin { 100% { transform: rotate(360deg); } }
		</style>
		<!-- Marked.js for Markdown parsing -->
		<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
		<!-- Highlight.js for syntax highlighting -->
		<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11.7.0/styles/github-dark.min.css">
		<script src="https://cdn.jsdelivr.net/npm/highlight.js@11.7.0/lib/highlight.min.js"></script>
	</head>
	<body>
		<div id="container">
			<div id="sidebar">
				<h3>Chat History</h3>
				<button id="newChatBtn">+ New Chat</button>
				<div id="historyList"></div>
				<button id="clearHistoryBtn">Clear History</button>
				<!-- File upload button -->
				<input type="file" id="fileInput" style="margin: 10px 20px 0 20px;" />
				<button id="pasteSnippetBtn" style="margin: 10px 20px 0 20px; background: #007acc; color: #fff; border: none; border-radius: 4px; padding: 6px 0; cursor: pointer; font-size: 0.95em;">Paste Snippet</button>
			</div>
			<div id="main">
				<h2>Ask AI Coding Assistant</h2>
				<div id="chat"></div>
				<div id="inputRow">
					<input id="userInput" type="text" placeholder="Ask a coding question..." />
					<button id="sendBtn">Send</button>
					<span id="spinner"><span class="spinner"></span></span>
				</div>
			</div>
		</div>
		<div id="snippetModal" style="display:none; position:fixed; top:0; left:0; width:100vw; height:100vh; background:#000a; z-index:1000; align-items:center; justify-content:center;">
			<div style="background:#23272e; padding:24px; border-radius:8px; min-width:340px; max-width:90vw;">
				<h3 style="color:#b5cea8; margin-top:0;">Paste Code Snippet</h3>
				<textarea id="snippetTextarea" rows="10" style="width:100%; font-size:1em; border-radius:4px; border:none; padding:8px;"></textarea>
				<div style="margin-top:12px; text-align:right;">
					<button id="submitSnippetBtn" style="background:#007acc; color:#fff; border:none; border-radius:4px; padding:6px 16px; margin-right:8px; cursor:pointer;">Submit</button>
					<button id="cancelSnippetBtn" style="background:#a42626; color:#fff; border:none; border-radius:4px; padding:6px 16px; cursor:pointer;">Cancel</button>
				</div>
			</div>
		</div>
		<script>
			const vscode = acquireVsCodeApi();
			let chatHistory = [];
			let allChats = [];
			let currentChatIndex = 0;
			let isWaiting = false;

			function hasUserMessage(chat) {
				return chat.some(m => m.role === 'user');
			}

			function renderHistorySidebar() {
				const historyList = document.getElementById('historyList');
				historyList.innerHTML = '';
				allChats.forEach((chat, idx) => {
					// Find the first user message for the label
					const firstUserMsg = chat.find(m => m.role === 'user');
					const label = firstUserMsg ? firstUserMsg.text.slice(0, 30) + (firstUserMsg.text.length > 30 ? '...' : '') : 'New Chat';
					const item = document.createElement('div');
					item.className = 'history-item' + (idx === currentChatIndex ? ' selected' : '');
					item.textContent = label;
					item.onclick = () => {
						currentChatIndex = idx;
						chatHistory = [...allChats[idx]];
						renderChat();
						renderHistorySidebar();
					};
					historyList.appendChild(item);
				});
			}

			document.getElementById('clearHistoryBtn').addEventListener('click', () => {
				allChats = [];
				chatHistory = [];
				currentChatIndex = 0;
				renderChat();
				renderHistorySidebar();
			});

			document.getElementById('newChatBtn').addEventListener('click', () => {
				if (chatHistory.length > 0 && hasUserMessage(chatHistory)) {
					allChats.push([...chatHistory]);
				}
				chatHistory = [];
				currentChatIndex = allChats.length;
				renderChat();
				renderHistorySidebar();
			});

			document.getElementById('sendBtn').onclick = sendMessage;
			document.getElementById('userInput').addEventListener('keydown', function(e) {
				if (e.key === 'Enter') sendMessage();
			});
			function renderChat() {
				const chatDiv = document.getElementById('chat');
				chatDiv.innerHTML = '';
				chatHistory.forEach(msg => {
					let bubble = document.createElement('div');
					if (msg.role === 'error') {
						bubble.className = 'bubble error';
						bubble.textContent = msg.text;
					} else {
						bubble.className = 'bubble ' + (msg.role === 'user' ? 'user' : 'ai');
						if (msg.role === 'ai') {
							bubble.innerHTML = renderMarkdown(msg.text);
						} else {
							bubble.textContent = msg.text;
						}
					}
					chatDiv.appendChild(bubble);
				});
				// Highlight code blocks after rendering
				if (window.hljs) {
					document.querySelectorAll('pre code').forEach((block) => {
						hljs.highlightElement(block);
					});
				}
				chatDiv.scrollTop = chatDiv.scrollHeight;
				document.getElementById('spinner').style.display = isWaiting ? 'inline-block' : 'none';
			}
			function renderMarkdown(text) {
				return marked.parse(text, {
					highlight: function(code, lang) {
						if (lang && window.hljs && hljs.getLanguage(lang)) {
							return hljs.highlight(code, { language: lang }).value;
						}
						return window.hljs ? hljs.highlightAuto(code).value : code;
					}
				});
			}
			function sendMessage() {
				const input = document.getElementById('userInput');
				const question = input.value.trim();
				if (!question) return;
				chatHistory.push({ role: 'user', text: question });
				renderChat();
				input.value = '';
				isWaiting = true;
				renderChat();
				vscode.postMessage({ command: 'askGroq', text: question });
				chatHistory.push({ role: 'ai', text: 'Thinking...' });
				renderChat();
			}
			renderChat();
			renderHistorySidebar();
			document.getElementById('fileInput').addEventListener('change', function(event) {
				const file = event.target.files[0];
				if (!file) return;
				const reader = new FileReader();
				reader.onload = function(e) {
					const content = e.target.result;
					vscode.postMessage({ command: 'uploadFile', fileName: file.name, fileSize: file.size, content });
				};
				reader.readAsText(file);
			});

			// Add this new event listener for groqResponse messages
			window.addEventListener('message', (event) => {
				console.log('Webview received message:', event);
				try {
					console.log('event.data:', JSON.stringify(event.data, null, 2));
				} catch (e) {
					console.log('event.data (raw):', event.data);
				}
				if (event.data && event.data.command === 'groqResponse') {
					console.log('Processing groqResponse:', event.data.text);
					// Remove any 'Thinking...' message
					chatHistory = chatHistory.filter(msg => !(msg.role === 'ai' && msg.text === 'Thinking...'));
					// Add the real AI response
					chatHistory.push({ role: 'ai', text: event.data.text });
					isWaiting = false;
					renderChat();
					renderHistorySidebar();
					console.log('Chat UI updated with AI response.');
					panel.webview.postMessage({ command: 'groqResponse', text: event.data.text });
				}
			});

			document.getElementById('pasteSnippetBtn').onclick = function() {
				document.getElementById('snippetModal').style.display = 'flex';
				document.getElementById('snippetTextarea').value = '';
			};
			document.getElementById('cancelSnippetBtn').onclick = function() {
				document.getElementById('snippetModal').style.display = 'none';
			};
			document.getElementById('submitSnippetBtn').onclick = function() {
				const snippet = document.getElementById('snippetTextarea').value;
				if (snippet.trim().length === 0) {
					alert('Please paste a code snippet.');
					return;
				}
				vscode.postMessage({ command: 'pasteSnippet', snippet });
				document.getElementById('snippetModal').style.display = 'none';
			};
		</script>
	</body>
	</html>
	`;
}
