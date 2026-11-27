/**
 * WikiVault frontend (logic.js)
 *
 * util/deploy.js transpiles and obfuscates this file into ../deploy/deploy.dat.
 * All top-level declarations share a single script scope.
 * Keep the order of code that runs at load time (Auth IIFE, Globals & State, Bootstrap).
 * VS Code: fold all sections with Ctrl+K Ctrl+0 to view them as a table of contents.
 *
 * Sections
 * 00. Constants          Constants, doc modal size limits
 * 01. Auth               OAuth session (wikiVaultAuth)
 * 02. Styles             initializeStyles (CSS)
 * 03. Globals & State    Global variables, window.wikiVault
 * 04. API                Wiki/server request functions
 * 05. Utilities          Clipboard, editor height adjustment
 * 06. Main Modal & Init  Initialization, main modal, tabs, common events
 * 07. Doc Modal          Document preview/translation modal
 * 08. Translation        Translation tab, translation UI, translation progress
 * 09. Save               Save dialog, page saving, talk page template
 * 10. Writing            Writing tab
 * 11. Search             Search, search results, existence indicators
 * 12. Suggested Pages    Suggested pages
 * 13. Command Palette    Command palette, floating button toggle, hotkey
 * 14. Settings & Info    Settings, info modal
 * 99. Bootstrap          App startup (must be last)
 */


//#region 00. Constants — Constants, doc modal size limits

const CONSTANTS = {
	API: {
		MAIN_URI: 'https://tedbot.toolforge.org',
		WIKIPEDIA_EN: 'https://en.wikipedia.org/w/api.php',
		WIKIPEDIA_KO: 'https://ko.wikipedia.org/w/api.php',
		TRANSLATE_ENDPOINT: '/api/translate',
		FASTTRANSLATE_ENDPOINT: '/api/fast-translate',
		SUGGESTED_PAGES_ENDPOINT: '/api/get-suggested-pages',
		CREATE_ENDPOINT: '/api/create'
	},
	CATEGORIES: [
		{
			key: "bothJaZh",
			label: "중요도 높음",
			bgColor: "var(--background-color-destructive-subtle, #ffe9e5)",
			textColor: "var(--color-destructive, #bf3c2c)"
		},
		{
			key: "eitherJaZh",
			label: "중요도 보통",
			bgColor: "var(--background-color-success-subtle, #dff2eb)",
			textColor: "var(--color-success, #177860)"
		},
		{
			key: "multiLang",
			label: "중요도 낮음",
			bgColor: "var(--background-color-progressive-subtle, #f1f4fd)",
			textColor: "var(--color-visited, #6a60b0)"
		}
	]
};

// Doc modal resizing
const RESIZE_HANDLE_WIDTH = 10; // Pixels from the right edge to detect resize
const RESIZE_HOVER_AREA_WIDTH = 30; // Pixels from the right edge to detect hover and expanded drag area
const MIN_DOC_MODAL_WIDTH = 700; // Minimum allowed width for the doc modal in pixels
const DEFAULT_DOC_MODAL_WIDTH = 700; // Original default width for the doc modal in pixels
const MAX_DOC_MODAL_WIDTH_ABSOLUTE = 800; // Max width cap from original CSS (800px)
const HORIZONTAL_SCREEN_PADDING = 20; // Padding from left/right screen edges in pixels (20px on each side)

//#endregion


//#region 01. Auth — OAuth session (wikiVaultAuth)

// WikiVault server login (OAuth 1.0a via the WikiVault server).
// The server verifies who the user is with Special:OAuth/identify and returns a
// signed session token, which is sent as "Authorization: Bearer <token>".
const wikiVaultAuth = (() => {
	const STORAGE_KEY = 'wikivault_auth_session';
	const MESSAGE_TYPE = 'wikivault-oauth';
	const EXPIRY_MARGIN_MS = 60 * 1000;
	let memorySession = null;
	let pendingLogin = null;

	// The token is shared by every tab through localStorage, so OAuth runs once per
	// wiki login and other tabs reuse it until it expires, the server rejects it (401),
	// the wiki account changes, or the user logs out of the wiki and back in.
	//
	// Detecting logout -> login: the CSRF token captured when OAuth finished (wikiCsrf)
	// is checked with action=checktoken. MediaWiki resets the token secret on every
	// login, so a token from a previous wiki login comes back "invalid".
	// (The CSRF string itself cannot be compared directly: it embeds a timestamp and
	// changes on every page load.)
	const verifyStatus = new Map();   // session.token -> 'pending' | 'valid' | 'invalid'
	const verifyPromises = new Map(); // session.token -> Promise<boolean>

	const dropToken = (token) => {
		if (memorySession && memorySession.token === token) memorySession = null;
		try {
			const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
			if (stored && stored.token === token) localStorage.removeItem(STORAGE_KEY);
		} catch (e) {
			// ignore
		}
	};

	const verifyWikiSession = (session) => {
		if (verifyPromises.has(session.token)) return verifyPromises.get(session.token);
		verifyStatus.set(session.token, 'pending');
		const check = !session.wikiCsrf
			? Promise.resolve(false) // saved by an older version: log in once more
			: Promise.resolve(mw.loader.using('mediawiki.api')).then(() => new mw.Api().get({
				action: 'checktoken',
				type: 'csrf',
				token: session.wikiCsrf,
				formatversion: 2
			})).then(
				(res) => !(res && res.checktoken && res.checktoken.result === 'invalid'),
				() => true // network/API trouble: don't force a login popup over it
			);
		const promise = check.then((valid) => {
			verifyStatus.set(session.token, valid ? 'valid' : 'invalid');
			if (!valid) dropToken(session.token);
			return valid;
		});
		verifyPromises.set(session.token, promise);
		return promise;
	};

	const isUsable = (session) => {
		if (!session || typeof session.token !== 'string' || typeof session.exp !== 'number') return false;
		if (session.exp - EXPIRY_MARGIN_MS <= Date.now()) return false;
		// Re-login if the wiki account changed since the token was issued
		const currentUser = mw.config.get('wgUserName');
		if (!currentUser || (session.username && session.username !== currentUser)) return false;
		const currentUserId = mw.config.get('wgUserId');
		if (session.userId && currentUserId && session.userId !== currentUserId) return false;
		return true;
	};

	// Usable session (wiki-login check may still be pending), or null.
	const readSession = () => {
		let session = null;
		if (isUsable(memorySession)) {
			session = memorySession;
		} else {
			try {
				const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
				if (isUsable(stored)) {
					memorySession = stored;
					session = stored;
				} else if (stored) {
					// Stale token (expired, other account, or logged out): drop it
					localStorage.removeItem(STORAGE_KEY);
				}
			} catch (e) {
				// localStorage unavailable or corrupted; fall through
			}
		}
		if (!session) return null;
		const status = verifyStatus.get(session.token);
		if (status === 'invalid') {
			dropToken(session.token);
			return null;
		}
		if (!status) verifyWikiSession(session);
		return session;
	};

	// Session confirmed to belong to the current wiki login, or null.
	const readVerifiedSession = () => {
		const session = readSession();
		return session && verifyStatus.get(session.token) === 'valid' ? session : null;
	};

	const saveSession = (session) => {
		memorySession = session;
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
		} catch (e) {
			// keep the in-memory copy only
		}
	};

	const clearSession = () => {
		memorySession = null;
		try {
			localStorage.removeItem(STORAGE_KEY);
		} catch (e) {
			// ignore
		}
	};

	const randomState = () => {
		const bytes = new Uint8Array(24);
		window.crypto.getRandomValues(bytes);
		return Array.prototype.map.call(bytes, (b) => ('0' + b.toString(16)).slice(-2)).join('');
	};

	// Must be called synchronously from a click handler, otherwise the popup is blocked.
	const login = () => {
		if (pendingLogin) {
			if (pendingLogin.popup && !pendingLogin.popup.closed) pendingLogin.popup.focus();
			return pendingLogin.promise;
		}

		const state = randomState();
		const url = CONSTANTS.API.MAIN_URI + '/oauth/login' +
			'?origin=' + encodeURIComponent(window.location.origin) +
			'&state=' + state;
		const popup = window.open(url, 'wikivault-oauth', 'width=600,height=720');
		if (!popup) {
			return Promise.reject(new Error('로그인 팝업이 차단되었습니다. 이 사이트의 팝업을 허용한 뒤 다시 시도해 주세요.'));
		}

		let resolveLogin, rejectLogin;
		const promise = new Promise((resolve, reject) => {
			resolveLogin = resolve;
			rejectLogin = reject;
		});

		let closedTimer = null;
		const finish = () => {
			window.removeEventListener('message', onMessage);
			window.removeEventListener('storage', onStorage);
			clearInterval(closedTimer);
			pendingLogin = null;
		};

		// Another tab finished logging in while this one was waiting: reuse its token.
		// (Both tabs share the 'wikivault-oauth' popup, so this tab's own message may never arrive.)
		const onStorage = (event) => {
			if (event.key !== STORAGE_KEY) return;
			memorySession = null;
			const session = readSession();
			if (!session) return;
			verifyWikiSession(session).then((valid) => {
				if (!valid || !pendingLogin || pendingLogin.promise !== promise) return;
				finish();
				resolveLogin(session);
			});
		};
		window.addEventListener('storage', onStorage);

		const onMessage = (event) => {
			if (event.origin !== CONSTANTS.API.MAIN_URI) return;
			const data = event.data;
			if (!data || data.type !== MESSAGE_TYPE || data.state !== state) return;
			finish();
			if (data.error || !data.token) {
				rejectLogin(new Error(data.error || '로그인에 실패했습니다.'));
				return;
			}
			const session = {
				token: data.token,
				exp: data.exp,
				username: data.username,
				userId: mw.config.get('wgUserId') || null,
				wikiCsrf: mw.user.tokens.get('csrfToken')
			};
			verifyStatus.set(session.token, 'valid');
			verifyPromises.set(session.token, Promise.resolve(true));
			saveSession(session);
			resolveLogin(session);
		};
		window.addEventListener('message', onMessage);

		closedTimer = setInterval(() => {
			if (!popup.closed) return;
			clearInterval(closedTimer);
			// Give a message posted right before closing a moment to arrive
			setTimeout(() => {
				if (pendingLogin && pendingLogin.promise === promise) {
					finish();
					rejectLogin(new Error('로그인 창이 닫혀 로그인이 완료되지 않았습니다.'));
				}
			}, 1000);
		}, 500);

		pendingLogin = { promise, popup };
		return promise;
	};

	const startLogin = (callback) => {
		mw.notify('WikiVault를 사용하려면 위키백과 계정으로 로그인해야 합니다. 열린 창에서 승인해 주세요.', { type: 'info' });
		login().then((session) => {
			mw.notify(session.username + ' 님으로 WikiVault에 로그인했습니다.', { type: 'success' });
			callback();
		}).catch((error) => {
			mw.notify(error.message, { type: 'error' });
		});
	};

	// Start the wiki-login check on page load so it is normally done before the first click
	readSession();

	return {
		hasSession: () => readVerifiedSession() !== null,
		login,
		logout: clearSession,
		// Run callback once logged in. Call it directly from a click handler.
		ensureLogin: (callback) => {
			const session = readSession();
			if (!session) {
				startLogin(callback);
				return;
			}
			if (verifyStatus.get(session.token) === 'valid') {
				callback();
				return;
			}
			// Check still running (rare: clicked right after page load). The popup opens
			// right after it, still within the click's user-activation window.
			verifyWikiSession(session).then((valid) => {
				if (valid) callback();
				else startLogin(callback);
			});
		},
		headers: (extra) => {
			const session = readSession();
			const headers = Object.assign({}, extra || {});
			if (session) headers.Authorization = 'Bearer ' + session.token;
			return headers;
		},
		applyToXhr: (xhr) => {
			const session = readSession();
			if (session) xhr.setRequestHeader('Authorization', 'Bearer ' + session.token);
		},
		// Call when the server answers 401: forget the token so the next action logs in again
		handleUnauthorized: () => {
			clearSession();
			mw.notify('WikiVault 로그인이 필요하거나 만료되었습니다. 다시 시도하면 로그인 창이 열립니다.', { type: 'warning' });
		}
	};
})();

//#endregion


//#region 02. Styles — initializeStyles (CSS)

// Whether to show the copy icon at the bottom-right of text boxes. Set to true to restore it.
// When false, the icon is hidden and its 35px right padding is not applied either.
const SHOW_COPY_ICON = false;

const initializeStyles = () => {
	const styles = `
		/* Modal Styles */
		.wikivault-small-text {
			font-size: 90%;
		}
		.wikivault-modal {
			position: fixed;
			background: var(--background-color-base, #fff);
			padding: 20px;
			box-shadow: 0 4px 10px rgba(0,0,0,0.5);
			border-radius: 10px;
			display: none;
		}

		/* Info Tab Styles */
		.wikivault-info-container {
			padding: 20px;
		}

		.wikivault-info-title {
			font-size: 1.2em;
			font-weight: bold;
			margin-bottom: 20px;
			color: var(--color-base, #202122);
			padding-bottom: 10px;
		}

		.wikivault-info-content {
			line-height: 1.6;
			color: var(--color-base--subtle, #54595d);
		}

		.wikivault-info-text {
			margin-bottom: 15px;
		}

		.wikivault-info-text2 {
			font-size: smaller;
			margin-bottom: 15px;
		}

		.wikivault-info-update-date {
			font-size: 0.9em;
			color: var(--color-base--subtle, #54595d);
			margin-top: 20px;
			padding-top: 15px;
			border-top: 1px solid var(--border-color-base, #a2a9b1);
		}

		/* New Link Card Styles */
		.wikivault-link-card {
			background-color: var(--background-color-neutral-subtle, #f8f9fa);
			border: 1px solid var(--border-color-base, #a2a9b1);
			padding: 10px 15px;
			display: block; /* Ensure it takes full width */
		}

		.wikivault-link-card a {
			color: var(--color-progressive, #36c);
			text-decoration: none;
			font-weight: normal;
		}

		.wikivault-link-card a:hover {
			text-decoration: underline;
		}

		.wikivault-modal-main {
			top: 5%;
			bottom: 5%;
			left: 50%;
			transform: translateX(-50%);
			width: min(90%, 800px);
			z-index: 1002;
			overflow: hidden;
		}

		.wikivault-modal-doc {
			top: 10%;
			left: 50%;
			transform: translateX(-50%);
			width: 700px;
			height: 80%;
			max-width: 90%;
			z-index: 1003;
		}

		.wikivault-doc-item {
			padding: 8px;
			background: var(--background-color-base, #fff);
			border-radius: 5px;
			border: 1px solid #ddd;
			flex: 1;
			text-align: center;
			cursor: pointer;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}

		.wikivault-overlay {
			position: fixed;
			top: 0;
			left: 0;
			width: 100%;
			height: 100%;
			background: rgba(0, 0, 0, 0.5);
			display: none;
			z-index: 1001;
		}

		/* Button Styles */
		.wikivault-button-primary {
			padding: 8px 15px;
			background: #007bff;
			color: white;
			border: none;
			border-radius: 5px;
			cursor: pointer;
		}

		.wikivault-button-disabled {
			opacity: 0.5;
		}

		/* Close Button Styles */
		.wikivault-close-btn {
			position: absolute;
			top: 15px; /* Adjusted from 10px to 15px */
			right: 3px;
			cursor: pointer;
			width: 28px; /* Increased from 24px to 28px */
			height: 28px; /* Increased from 24px to 28px */
			padding: 4px; /* Added padding for better touch target */
		}

		.wikivault-doc-modal-close-btn {
			margin-left: 15px;
			cursor: pointer;
			width: 24px;
			height: 24px;
		}

		/* Tab Styles */
		.wikivault-tab-container {
			display: flex;
			border-bottom: 2px solid #007bff;
			margin-bottom: 10px;
		}

		.wikivault-tab {
			padding: 10px 20px;
			cursor: pointer;
			font-weight: bold;
			border-radius: 5px 5px 0 0;
		}

		.wikivault-tab-content {
			font-size: larger;
			padding: 10px;
			height: calc(100% - 60px);
			overflow-y: auto;
			overflow-x: hidden;
		}

		/* Search Styles */
		.wikivault-search-container {
			display: flex;
			align-items: center;
			gap: 5px;
		}

		.wikivault-search-result-item {
			display: flex;
			align-items: center;
			padding: 8px;
			border: 1px solid #ddd;
			border-radius: 5px;
			background-color: var(--background-color-base, #fff);
			margin-bottom: 5px;
			cursor: pointer;
			position: relative;
		}

		.wikivault-result-text-container {
			display: flex;
			flex-direction: column;
			flex: 1;
			padding-right: 80px;
		}

		/* Category Styles */
		.wikivault-category-box {
			border-radius: 8px;
			padding: 10px;
			margin-bottom: 10px;
		}

		.wikivault-category-title {
			font-size: 85%;
			font-weight: bold;
		}

		.wikivault-doc-list-container {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 10px;
			overflow: hidden;
			position: relative;
		}

		.wikivault-suggested-container {
			padding-top: 10px;
		}

		/* Settings Styles */
		.wikivault-settings-container {
			padding: 10px;
		}

		.wikivault-settings-header {
			font-size: 1.5em;
			font-weight: bold;
			margin: 0 0 20px 0;
			padding-bottom: 10px;
			border-bottom: 2px solid var(--border-color-base, #a2a9b1);
			color: var(--color-base, #202122);
		}

		.wikivault-settings-section {
			margin-bottom: 20px;
			border: 1px solid #ddd;
			border-radius: 8px;
			padding: 15px;
			background-color: var(--background-color-neutral-subtle, #f8f9fa);
		}

		.wikivault-settings-title {
			font-weight: bold;
			margin-bottom: 15px;
			font-size: 1em;
		}

		.wikivault-settings-content {
			margin-left: 15px;
			font-size: 90%;
		}

		.wikivault-settings-item {
			margin-bottom: 15px;
			display: flex; /* Added for layout */
			align-items: flex-start; /* Align items to the start of the cross axis */
			gap: 20px; /* Space between label and content */
		}

		.wikivault-settings-label-wrapper { /* New wrapper for the label */
			flex-basis: 120px; /* Fixed width for the label column */
			flex-shrink: 0;
			font-weight: bold;
			font-size: 1em;
			padding-top: 8px; /* Align with checkbox/input visually */
		}

		.wikivault-settings-control-group { /* New wrapper for settings controls */
			flex-grow: 1; /* Allow controls to take remaining space */
		}

		.wikivault-settings-option {
			margin-bottom: 10px; /* Adjusted margin */
		}

		.wikivault-setting-label {
			display: inline-block;
			margin-left: 5px; /* Space for checkbox */
		}

		/* Command Palette Styles */
		.wikivault-command-palette {
			position: fixed;
			top: 50%;
			left: 50%;
			transform: translate(-50%, -50%);
			width: min(95%, 500px);
			background: rgba(0, 0, 0, 0.8);
			box-shadow: 0 5px 15px rgba(0,0,0,0.5);
			border-radius: 8px;
			padding: 15px;
			z-index: 2000;
			display: none;
			box-sizing: border-box;
		}

		.wikivault-command-input {
			flex: 1;
			padding: 10px;
			border: 1px solid #555;
			border-radius: 4px;
			background-color: #333;
			color: white;
			font-size: 1em;
		}

		/* Loading Animation */
		.loading-dots {
			display: flex;
			justify-content: center;
			align-items: center;
			height: 100%;
			min-height: 100px;
		}

		.loading-dots span {
			width: 12px;
			height: 12px;
			margin: 0 6px;
			border-radius: 50%;
			background-color: var(--color-base, #202122);
			display: inline-block;
			animation: dots 1.4s infinite ease-in-out both;
		}

		.loading-dots span:nth-child(1) { animation-delay: -0.32s; }
		.loading-dots span:nth-child(2) { animation-delay: -0.16s; }
		.loading-dots span:nth-child(3) { animation-delay: 0s; }

		@keyframes dots {
			0%, 80%, 100% { 
				transform: scale(0);
				opacity: 0.3;
			}
			40% { 
				transform: scale(1);
				opacity: 1;
			}
		}

		/* Doc Modal Styles */
		.wikivault-doc-modal-header {
			display: flex;
			justify-content: space-between;
			align-items: center;
			margin-bottom: 20px;
			min-height: 32px;
		}

		.wikivault-doc-modal-title {
			margin: 0;
			flex: 1;
			font-size: 1.5em;
			margin-right: 15px;
			/* Add text truncation */
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}

		.wikivault-doc-modal-content {
			height: calc(100% - 120px);
			overflow-y: auto;
		}

		.wikivault-doc-modal-edit {
			width: 100%;
			height: 100%;
			padding: 10px;
			border: 1px solid #ddd;
			border-radius: 5px;
			resize: none;
		}

		.wikivault-doc-modal-read {
			user-select: text;
			pointer-events: auto;
			cursor: default;
		}

		.wikivault-doc-modal-tabs {
			border-bottom: 1px solid #ddd;
			margin-bottom: 15px;
		}

		.wikivault-doc-modal-tab {
			padding: 8px 15px;
			border: none;
			background: var(--background-color-progressive-subtle, #f1f4fd);
			color: var(--color-disabled, #a2a9b1);
			cursor: pointer;
			border-radius: 5px 5px 0 0;
			margin-right: 5px;
		}

		.wikivault-doc-modal-tab-active {
			background: #007bff;
			color: white;
		}

		.wikivault-doc-modal-tab-disabled {
			opacity: 0.5;
		}

		/* Button Container Styles */
		.modal-right-buttons {
			display: flex;
			align-items: center;
			margin-left: auto;
		}

		/* Only apply not-allowed cursor when button is both disabled and has the disabled class */
		.wikivault-button-primary:disabled.wikivault-button-disabled {
			opacity: 0.5;
			cursor: not-allowed;
			pointer-events: none;
		}

		/* Settings Styles */
		.wikivault-settings-note {
			font-size: 85%;
			color: #666;
			margin-top: 10px;
		}

		.wikivault-setting-description {
			color: #666;
			margin-top: 5px;
		}

		.wikivault-setting-warning {
			color: #c0392b;
			font-size: smaller;
			margin-top: 2px;
		}

		.warning-icon {
			font-weight: bold;
			margin-right: 5px;
		}

		.wikivault-temperature-control {
			display: flex;
			align-items: center;
			gap: 10px;
			margin-top: 5px;
		}

		.wikivault-temperature-value {
			flex-shrink: 0;
		}

		.wikivault-setting-input[type="range"] {
			flex-grow: 1;
		}

		/* Textarea with Copy Button Container */
		.wikivault-textarea-container {
			position: relative;
			width: 100%; /* Take full width of parent */
			height: 100%; /* Take full height of parent */
			display: flex; /* Use flex to make child textarea fill height */
			flex-direction: column; /* Stack children vertically if needed, but here for height */
		}

		/* Copy Icon Styles */
		.wikivault-copy-icon {
			position: absolute;
			bottom: 15px; /* Position from bottom */
			right: 25px; /* Position from right */
			width: 18px; /* Icon size */
			height: 18px; /* Icon size */
			cursor: pointer;
			fill: var(--color-base--subtle, #54595d); /* Icon color */
			z-index: 1; /* Ensure it's above textarea */
			opacity: 0.7; /* Slightly transparent */
			transition: opacity 0.2s ease;
		}

		.wikivault-copy-icon:hover {
			opacity: 1.0; /* Full opacity on hover */
			fill: var(--color-base, #202122); /* Change color on hover */
		}

		/* Copy icon disabled via SHOW_COPY_ICON (overrides jQuery .show()) */
		.wikivault-copy-icon.wikivault-copy-icon-hidden {
			display: none !important;
		}

		/* Padding for textarea to not hide scrollbar (only when copy icon is shown) */
		${SHOW_COPY_ICON ? `
		.wikivault-doc-modal-edit,
		.wikivault-writing-content,
		#wikivault-translated-content,
		#wikivault-original-content {
			padding-right: 35px !important; /* Add padding to make space for the icon */
		}` : ''}

		/* Cancel Button Styles */
		.wikivault-cancel-button {
			position: fixed;
			top: 15px;
			left: 50%;
			transform: translateX(-50%);
			z-index: 2000;
			padding: 8px 20px;
			background-color: var(--background-color-destructive, #bf3c2c);
			color: white;
			border: none;
			border-radius: 5px;
			cursor: pointer;
			display: none; /* Hidden by default */
			box-shadow: 0 2px 5px rgba(0,0,0,0.2);
		}

		.ui-dialog {
			z-index: 4000 !important;
		}
		
		.ui-widget-overlay {
			z-index: 3099 !important;
		}

		.wikivault-cancel-button:hover {
			background-color: var(--background-color-destructive--hover, #9f3526);
		}

		/* Ensure WikiEditor text area wrapper takes full height */
		#wikivault-doc-modal .wikivault-textarea-container .wikiEditor-ui-text {
			height: 100%;
		}

		/* Ensure WikiEditor text area wrapper has relative positioning for absolute children */
		#wikivault-doc-modal .wikivault-textarea-container .wikiEditor-ui-text {
			position: relative;
		}

		/* Writing Tab Styles */
		#wikivault-writing-title,
		#wikivault-writing-context,
		.wikivault-writing-content {
			box-sizing: border-box;
		}

		.wikivault-modal .tool[rel="realtimepreview"],
		.wikivault-modal .tool[rel="veEditSwitch"],
		.wikivault-modal .tool[rel="signature"],
		.wikivault-modal .tool[rel="template-wizard"],
		.wikivault-modal .tool[rel="reference"],
		.wikivault-modal .tool[rel="codemirror"],
		.wikivault-modal .ext-WikiEditor-ResizingDragBar {
			display: none;
		}
		
		.wikivault-modal .wikiEditor-ui-text {
			height: 100% !important;
		}

		/* Search Results Modal Specific Styles */
		#wikivault-search-results-modal .wikivault-doc-modal-edit {
			background-color: var(--background-color-base, #fff);
			color: var(--color-base, #202122);
			${SHOW_COPY_ICON ? 'padding-right: 35px !important; /* Ensure padding for copy icon */' : ''}
		}

		/* Resizable Pane Styles */
		.wikivault-resizable-pane {
			width: 100%;
			height: 8px;
			background-color: var(--background-color-neutral-subtle, #f8f9fa);
			border-top: 1px solid var(--border-color-base, #a2a9b1);
			border-bottom: 1px solid var(--border-color-base, #a2a9b1);
			cursor: ns-resize;
			position: relative;
			z-index: 30;
		}

		.wikivault-resizable-pane:hover {
			background-color: var(--background-color-progressive-subtle, #f1f4fd);
		}

		.wikivault-resizable-pane::after {
			content: '';
			position: absolute;
			left: 50%;
			top: 50%;
			transform: translate(-50%, -50%);
			width: 30px;
			height: 4px;
			background-color: var(--color-base--subtle, #54595d);
			border-radius: 2px;
		}

		/* Top Right Icons Container */
		.wikivault-top-right-icons {
			position: absolute;
			top: 15px; /* Adjusted to match close button */
			right: 50px; /* Increased from 40px to 50px to give more space */
			display: flex;
			align-items: center;
			gap: 12px; /* Increased from 8px to 12px for better spacing */
		}

		.wikivault-icon-button {
			width: 28px; /* Increased from 24px to 28px */
			height: 28px; /* Increased from 24px to 28px */
			padding: 4px; /* Added padding for better touch target */
			display: flex;
			align-items: center;
			justify-content: center;
		}

		.wikivault-icon-button svg {
			width: 24px; /* Increased from 20px to 24px */
			height: 24px; /* Increased from 20px to 24px */
		}
	`;

	const styleElement = document.createElement('style');
	styleElement.textContent = styles;
	document.head.appendChild(styleElement);
};

//#endregion


//#region 03. Globals & State — Global variables, window.wikiVault

const wikiVaultFloatingButton = $("#wikivault-floating-button");
const wgUserId = mw.config.get("wgUserId");
const wgUserIsTemp = mw.config.get("wgUserIsTemp");
const wgUserName = mw.config.get("wgUserName");
let wikiVaultModalWindow, wikiVaultOverlay, wikiVaultCloseBtn, wikiVaultTabContainer, wikiVaultContentArea;
let wikiVaultDocModal, wikiVaultDocModalCloseBtn, wikiVaultDocModalTitle, wikiVaultDocModalContent;
let translatedContent, backButton, aiTranslateBtn, editTab, saveTranslationBtn;
let currentWikiText = '';
let wikiVaultInitialized = false;
let wikiVaultTabData = {};

// Command palette elements
let wikiVaultCommandPalette, wikiVaultCommandInput;

// Cancel button
let wikiVaultCancelButton;

// Main translation container
let wikiVaultTranslationContainer;

// WikiVault state (window.wikiVault)
window.wikiVault = window.wikiVault || {};
wikiVault.init = wikiVault.init || false;
wikiVault.isDocModalUserTriggered = false; // Whether the doc modal was opened by user action
wikiVault.isHotkeyActive = false; // Whether the hotkey toggle is active
wikiVault.hotkeyState = null; // Modal visibility saved before hiding via hotkey

//#endregion


//#region 04. API — Wiki/server request functions

const wikiVaultSearchTitle = (lang, title) => {
	const uri = `https://${lang}.wikipedia.org/w/rest.php/v1/search/title?q=${encodeURIComponent(title.replace(/ +/g, '_'))}&limit=10`;
	return $.ajax({
		url: uri,
		type: 'GET',
		dataType: 'json'
	});
};

const fetchWikiText = (title) => {
	return $.get(CONSTANTS.API.WIKIPEDIA_EN, {
		action: 'parse',
		format: 'json',
		origin: '*',
		prop: 'wikitext',
		page: title
	});
};

const fetchWikidataId = async (title) => {
	try {
		const response = await fetch(
			CONSTANTS.API.WIKIPEDIA_EN + `?action=query&prop=pageprops&ppprop=wikibase_item&format=json&origin=*&titles=${encodeURIComponent(title)}`
		);
		const data = await response.json();

		if (data.query && data.query.pages) {
			const page = Object.values(data.query.pages)[0];
			if (page.pageprops && page.pageprops.wikibase_item) {
				return page.pageprops.wikibase_item;
			}
		}
		return null;
	} catch (error) {
		console.error('Error fetching Wikidata ID:', error);
		return null;
	}
};

const checkKoreanWikiExistence = async (titles) => {
	try {
		const existenceMap = {};
		let continueParams = {};
		
		do {
			// Build query parameters
			const queryParams = new URLSearchParams({
				action: 'query',
				prop: 'langlinks',
				lllimit: '500',
				format: 'json',
				origin: '*',
				redirects: '',
				titles: titles
			});
			
			// Add continue parameters if they exist
			if (continueParams.llcontinue) {
				queryParams.append('llcontinue', continueParams.llcontinue);
			}
			
			const response = await fetch(
				CONSTANTS.API.WIKIPEDIA_EN + `?${queryParams.toString()}`
			);
			const data = await response.json();
			
			// Process response
			if (data.query && data.query.pages) {
				Object.values(data.query.pages).forEach(page => {
					if (!existenceMap[page.title]) {
						existenceMap[page.title] = {
							exists: false,
							koTitle: null,
							title: page.title,
							langCount: 0
						};
					}
					
					if (page.langlinks) {
						const hasKorean = page.langlinks.some(link => link.lang === 'ko');
						const koLink = page.langlinks.find(link => link.lang === 'ko');
						
						existenceMap[page.title].exists = existenceMap[page.title].exists || hasKorean;
						if (hasKorean && !existenceMap[page.title].koTitle) {
							existenceMap[page.title].koTitle = koLink['*'];
						}
						existenceMap[page.title].langCount += page.langlinks.length;
					}
				});
			}
			
			// Check for continuation
			continueParams = data.continue || {};
		} while (continueParams.llcontinue);
		
		return existenceMap;
	} catch (error) {
		console.error('Error checking Korean Wikipedia existence:', error);
		return {};
	}
};

//#endregion


//#region 05. Utilities — Clipboard, editor height adjustment

// Copy icon and clipboard helpers (SHOW_COPY_ICON is defined in region 02)
const createCopyIcon = () => {
    const hiddenClass = SHOW_COPY_ICON ? '' : ' wikivault-copy-icon-hidden';
    return $('<svg class="wikivault-copy-icon' + hiddenClass + '" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">' +
        '<path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/>' +
        '</svg>');
};

const copyTextToClipboard = (text) => {
    navigator.clipboard.writeText(text).then(() => {
        mw.notify('클립보드에 복사되었습니다.', { type: 'success', tag: 'wikivault-copy' });
    }).catch(err => {
        console.error('Failed to copy text:', err);
        mw.notify('클립보드 복사에 실패했습니다.', { type: 'error', tag: 'wikivault-copy' });
    });
};

// Adjust the height of the WikiEditor bottom bar
const adjustWikiEditorHeight = () => {
    const modeIndicator = wikiVaultDocModal.find('.ko-wiki-modal-mode');
    if (!modeIndicator.length) return;

    const mode = modeIndicator.text();

    if (mode === '● 번역 준비 모드') {
        const readArea = $('#wikivault-original-content-container');
        const editArea = $('#wikivault-doc-modal-edit');
        // Find the WikiEditor wrapper for the original textarea
        const wikiEditorWrapper = editArea.closest('.wikiEditor-ui');
        const toolbar = wikiEditorWrapper.find('.wikiEditor-ui-toolbar');
        const bottomBar = wikiEditorWrapper.find('.wikiEditor-ui-bottom');

        if (readArea.is(':visible') && wikiEditorWrapper.length && toolbar.length && bottomBar.length) {
            // Get the height of the textarea container
            const textareaContainer = editArea.closest('.wikivault-textarea-container');
            const availableHeight = textareaContainer.height() - toolbar.height() - 10;
            bottomBar.css('height', Math.max(0, availableHeight) + 'px');
        }
    } else if (mode === '● 번역 편집 모드') {
        const translatedEditArea = $('#wikivault-translated-content');
        // Find the WikiEditor wrapper for the translated textarea
        const wikiEditorWrapper = translatedEditArea.closest('.wikiEditor-ui');
        const toolbar = wikiEditorWrapper.find('.wikiEditor-ui-toolbar');
        const bottomBar = wikiEditorWrapper.find('.wikiEditor-ui-bottom');

        if (wikiVaultTranslationContainer.is(':visible') && wikiEditorWrapper.length && toolbar.length && bottomBar.length) {
            // Get the height of the translated textarea container
            const textareaContainer = translatedEditArea.closest('.wikivault-textarea-container');
            const availableHeight = textareaContainer.height() - toolbar.height() - 10;
            bottomBar.css('height', Math.max(0, availableHeight) + 'px');
        }
    }
};

//#endregion


//#region 06. Main Modal & Init — Initialization, main modal, tabs, common events

const wikiVaultInit = () => {
	function loadUI() {
		mw.loader.using([
			"oojs-ui-core",
			"oojs-ui-widgets",
			"oojs-ui-toolbars",
			"oojs-ui-windows",
			"mediawiki.ForeignApi"
		]).done(() => {
			initializeUI(); // Initialize the rest of the UI
		});
	}

	window.wikiVault = window.wikiVault || { init: false };
	if (window.wikiVault.init) return;
	window.wikiVault.init = true;

	// Initialize CSS styles unconditionally
	initializeStyles();

	// Create the command palette UI regardless of user status, but only once
	createCommandPaletteUI();
	// Setup the hotkey for the command palette immediately
	setupModalHotkey();

	if (!wikiVaultFloatingButton.length) {
		console.error("Failed to find the floating button");
		return;
	}

	if (wgUserIsTemp || wgUserId === null) {
		return;
	}
	loadUI();
};

const initializeUI = () => {
	if (typeof OO === 'undefined' || (typeof OO.ui === 'undefined')) {
		console.error("OO is not ready.");
		return;
	}

	if (wikiVaultInitialized) {
		wikiVaultModalWindow.show();
		wikiVaultOverlay.show();
		wikiVaultFloatingButton.hide();
		return;
	}

	createModalWindow();
	createDocModal();
	setupTabContainer();
	setupEventHandlers();

	// Add resize event listener to adjust WikiEditor height
	$(window).on('resize', adjustWikiEditorHeight);

	// Add window resize listener for doc modal width
	$(window).on('resize', function() {
		if (wikiVaultDocModal.is(':visible')) {
			const currentWidth = wikiVaultDocModal.width();
			const maxAllowedWidth = $(window).width() - (HORIZONTAL_SCREEN_PADDING * 2);
			
			if (currentWidth > maxAllowedWidth) {
				wikiVaultDocModal.css('width', maxAllowedWidth + 'px');
			}
			// If the window expands, the modal should retain its set width (unless it was previously capped)
			// The loadDocModalWidth function handles this implicitly by returning the default or saved width
			// which will be capped by the new maxAllowedWidth if the saved width is larger.
			// We don't need to force a larger width on expand.
		}
	});

	// Add click event listener to adjust WikiEditor height when clicking inside the doc modal content
	wikiVaultDocModal.on('click', '.wikiEditor-ui', adjustWikiEditorHeight);

	// Add click event listener for the translated content's WikiEditor UI as well
	wikiVaultTranslationContainer.on('click', '.wikiEditor-ui', adjustWikiEditorHeight);

	wikiVaultInitialized = true;

	styleFloatingButton();
	createCancelButton(); // Create the cancel button
};

const styleFloatingButton = () => {
	wikiVaultFloatingButton.css({
		'transition': 'all 0.1s ease-in-out',
		'background-color': '#007bff',
		'cursor': 'pointer',
		'opacity': '1.0',
		'box-shadow': '0 2px 3px rgba(0,0,0,0.1)'
	});

	wikiVaultFloatingButton.one('transitionend', () => {
		wikiVaultFloatingButton.css('transition', 'none');
	});
};

const createModalWindow = () => {
	wikiVaultModalWindow = $('<div id="wikivault-modal-window"></div>')
		.addClass('wikivault-modal wikivault-modal-main')
		.appendTo('body');

	wikiVaultOverlay = $('<div id="wikivault-overlay"></div>')
		.addClass('wikivault-overlay')
		.appendTo('body');

	createCloseButton();
};

const createCloseButton = () => {
	const svgIcon = `<svg style="fill: var(--color-base, #202122);" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
		<g id="SVGRepo_iconCarrier">
			<g data-name="Layer 2">
				<g data-name="collapse">
					<rect width="24" height="24" transform="rotate(180 12 12)" opacity="0"></rect>
					<path d="M19 9h-2.58l3.29-3.29a1 1 0 1 0-1.42-1.42L15 7.57V5a1 1 0 0 0-1-1 1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h5a1 1 0 0 0 0-2z"></path>
					<path d="M10 13H5a1 1 0 0 0 0 2h2.57l-3.28 3.29a1 1 0 0 0 0 1.42 1 1 0 0 0 1.42 0L9 16.42V19a1 1 0 0 0 1 1 1 1 0 0 0 1-1v-5a1 1 0 0 0-1-1z"></path>
				</g>
			</g>
		</g>
	</svg>`;

	wikiVaultCloseBtn = $('<div id="wikivault-close-btn"></div>')
		.addClass('wikivault-close-btn')
		.html(svgIcon)
		.appendTo(wikiVaultModalWindow);
};

const setupEventHandlers = () => {
	wikiVaultCloseBtn.on('click', handleModalClose);
	wikiVaultDocModalCloseBtn.on('click', handleDocModalClose);
	//wikiVaultFloatingButton.on('click touchstart', handleFloatingButtonClick);
	wikiVaultFloatingButton.on('mouseup touchend', handleFloatingButtonClick);
};

const handleModalClose = () => {
	wikiVaultModalWindow.hide();
	wikiVaultOverlay.hide();
	wikiVaultFloatingButton.show();
};

const handleDocModalClose = () => {
	if (translatedContent && translatedContent.is(':visible')) {
		backButton.trigger('click');
	}
	
	if (window.currentTranslationXHR) {
		window.currentTranslationXHR.abort();
		window.currentTranslationXHR = null;
	}
	
	wikiVaultDocModal.hide();
	wikiVaultModalWindow.css({
		opacity: '1',
		pointerEvents: 'auto'
	});
};

const handleFloatingButtonClick = () => {
	if (wikiVaultFloatingButton.data('dragging')) return;
	toggleFloatingButton();
};

const createCancelButton = () => {
	wikiVaultCancelButton = $('<button id="wikivault-cancel-button" class="wikivault-cancel-button">❌ 취소</button>')
		.appendTo('body')
		.on('click', handleCancelClick);
};

const handleCancelClick = () => {
	if (window.currentTranslationXHR) {
		window.currentTranslationXHR.abort();
		window.currentTranslationXHR = null;
		mw.notify('번역이 취소되었습니다.', { type: 'info' });
		// Cleanup translation UI
		$('#wikivault-translation-loading').hide();
		$('#wikivault-translated-content').val($('#wikivault-translated-content').val() + '\n[사용자에 의해 취소됨]\n');
		$('#wikivault-translated-content').prop('readonly', false);
		saveTranslationBtn.prop('disabled', false).css('opacity', '1');
		// Re-enable preview tab
		const translatedTabContainer = $('.translation-tab-container');
		const previewTab = translatedTabContainer.data('previewTab');
		if (previewTab) {
			previewTab.prop('disabled', false).css({ cursor: 'pointer', opacity: '1' });
		}
	} else if (window.currentWritingXHR) {
		window.currentWritingXHR.abort();
		window.currentWritingXHR = null;
		mw.notify('글 생성이 취소되었습니다.', { type: 'info' });
		// Cleanup writing UI
		$('#wikivault-writing-result .loading-dots').hide();
		$('#wikivault-writing-result .wikivault-writing-content').val($('#wikivault-writing-result .wikivault-writing-content').val() + '\n[사용자에 의해 취소됨]\n');
		// Re-enable writing inputs and button
		$('#wikivault-writing-title').prop('disabled', false);
		$('#wikivault-writing-context').prop('disabled', false);
		$('.wikivault-button-primary:contains("글쓰기 시작")').prop('disabled', false).removeClass('wikivault-button-disabled');
	}
	wikiVaultCancelButton.hide();
};

const setupTabContainer = () => {
	wikiVaultTabContainer = $('<div id="wikivault-tab-container"></div>')
		.addClass('wikivault-tab-container')
		.appendTo(wikiVaultModalWindow);

	wikiVaultContentArea = $('<div id="wikivault-tab-content"></div>')
		.addClass('wikivault-tab-content')
		.appendTo(wikiVaultModalWindow);

	// Add default tabs with i18n-friendly IDs
	addTab('번역', '<div id="wikivault-ai-translation-area"></div>', 'translation', true);
	// Disable ai-create-area
	//addTab('글쓰기', '<div id="wikivault-ai-create-area"></div>', 'writing');

	// Create top right icons container
	const topRightIcons = $('<div class="wikivault-top-right-icons"></div>').css({
		'position': 'absolute',
		'top': '15px', /* Adjusted to match close button */
		'right': '50px', /* Increased from 40px to 50px to give more space */
		'display': 'flex',
		'align-items': 'center',
		'gap': '12px' /* Increased from 8px to 12px for better spacing */
	}).appendTo(wikiVaultModalWindow);

	// Add settings icon
	const settingsIcon = $('<div class="wikivault-icon-button" title="설정"></div>')
		.html('<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M19.14,12.94c0.04-0.3,0.06-0.61,0.06-0.94c0-0.32-0.02-0.64-0.07-0.94l2.03-1.58c0.18-0.14,0.23-0.41,0.12-0.61 l-1.92-3.32c-0.12-0.22-0.37-0.29-0.59-0.22l-2.39,0.96c-0.5-0.38-1.03-0.7-1.62-0.94L14.4,2.81c-0.04-0.24-0.24-0.41-0.48-0.41 h-3.84c-0.24,0-0.43,0.17-0.47,0.41L9.25,5.35C8.66,5.59,8.12,5.92,7.63,6.29L5.24,5.33c-0.22-0.08-0.47,0-0.59,0.22L2.74,8.87 C2.62,9.08,2.66,9.34,2.86,9.48l2.03,1.58C4.84,11.36,4.8,11.69,4.8,12s0.02,0.64,0.07,0.94l-2.03,1.58 c-0.18,0.14-0.23,0.41-0.12,0.61l1.92,3.32c0.12,0.22,0.37,0.29,0.59,0.22l2.39-0.96c0.5,0.38,1.03,0.7,1.62,0.94l0.36,2.54 c0.05,0.24,0.24,0.41,0.48,0.41h3.84c0.24,0,0.44-0.17,0.47-0.41l0.36-2.54c0.59-0.24,1.13-0.56,1.62-0.94l2.39,0.96 c0.22,0.08,0.47,0,0.59-0.22l1.92-3.32c0.12-0.22,0.07-0.47-0.12-0.61L19.14,12.94z M12,15.6c-1.98,0-3.6-1.62-3.6-3.6 s1.62-3.6,3.6-3.6s3.6,1.62,3.6,3.6S13.98,15.6,12,15.6z"/></svg>')
		.css({
			'cursor': 'pointer',
			'color': 'var(--color-base, #202122)',
			'padding': '4px',
			'border-radius': '4px',
			'transition': 'background-color 0.2s'
		})
		.hover(
			function() { $(this)[0].style.setProperty('background-color', 'var(--background-color-neutral-subtle, #f8f9fa)'); },
			function() { $(this).css('background-color', 'transparent'); }
		)
		.on('click', function() {
			showSettingsModal();
		})
		.appendTo(topRightIcons);

	// Add info icon
	const infoIcon = $('<div class="wikivault-icon-button" title="정보"></div>')
		.html('<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/></svg>')
		.css({
			'cursor': 'pointer',
			'color': 'var(--color-base, #202122)',
			'padding': '4px',
			'border-radius': '4px',
			'transition': 'background-color 0.2s'
		})
		.hover(
			function() { $(this)[0].style.setProperty('background-color', 'var(--background-color-neutral-subtle, #f8f9fa)'); },
			function() { $(this).css('background-color', 'transparent'); }
		)
		.on('click', function() {
			showInfoModal();
		})
		.appendTo(topRightIcons);
};

const addTab = (displayName, content, tabId, isDefault = false) => {
	if (wikiVaultTabData[tabId]) return;

	wikiVaultTabData[tabId] = content;
	const tab = createTabElement(displayName, tabId);
	const tabContent = createTabContent(tabId, content);

	if (tabId === 'translation') {
		setupTranslationTab(tabContent);
	} else if (tabId === 'writing') {
		setupWritingTab(tabContent);
	}

	if (isDefault) {
		activateTab(tab, tabContent);
	}
};

const createTabElement = (displayName, tabId) => {
	return $('<div class="wikivault-tab" data-tab-id="' + tabId + '">' + displayName + '</div>')
	.appendTo(wikiVaultTabContainer)
	.on('click', function() {
		if (wikiVaultCancelButton.is(':visible')) {
			return;
		}
		$('.wikivault-tab').each(function () {
			$(this).css('background', 'transparent');
			this.style.setProperty('color', 'var(--color-base, #202122)');
		});
		$(this).css({
			background: '#007bff',
			color: 'white'
		});
		wikiVaultContentArea.children().hide();
		$('#wikivault-tab-' + tabId).show();
	});
};

const createTabContent = (tabId, content) => {
	return $('<div id="wikivault-tab-' + tabId + '"></div>')
		.html(content)
		.appendTo(wikiVaultContentArea)
		.hide();
};

const activateTab = (tab, content) => {
	tab.css({
		background: '#007bff',
		color: 'white'
	});
	content.show();
};

const hideMainUI = () => {
    $('.wikivault-doc-modal-tabs').hide();
    wikiVaultDocModalContent.hide();
    aiTranslateBtn.hide();
};

const showMainUI = () => {
    $('.wikivault-doc-modal-tabs').show();
    wikiVaultDocModalContent.show();
    aiTranslateBtn.show();
};

const disableMainModal = () => {
	wikiVaultModalWindow.css({
		opacity: '0.5',
		pointerEvents: 'none'
	});
};

const disableButtons = () => {
	aiTranslateBtn.prop('disabled', true).css('opacity', '0.5');
};

const enableButtons = () => {
	aiTranslateBtn.prop('disabled', false).css('opacity', '1'); // Enable AI Translate button after fetch
};

//#endregion


//#region 07. Doc Modal — Document preview/translation modal

const createDocModal = () => {
	wikiVaultDocModal = $('<div id="wikivault-doc-modal"></div>')
		.addClass('wikivault-modal wikivault-modal-doc')
		.appendTo('body');

	const modalHeader = createDocModalHeader();
	setupDocModalTabs(); // This creates the tabs
	createDocModalContent();
	setupTranslationUI(modalHeader);

	let isResizing = false;
	let startMouseX;
	let startWidth;

	// Cursor change on hover and expanded drag area
	wikiVaultDocModal.on('mousemove', function(e) {
		const rect = $(this)[0].getBoundingClientRect();
		if (e.clientX > rect.right - RESIZE_HOVER_AREA_WIDTH && e.clientX < rect.right + RESIZE_HOVER_AREA_WIDTH) {
			$(this).css('cursor', 'ew-resize');
		} else {
			$(this).css('cursor', 'auto');
		}
	});

	wikiVaultDocModal.on('mouseleave', function() {
		$(this).css('cursor', 'auto');
	});

	wikiVaultDocModal.on('mousedown touchstart', function(e) {
		// Only allow resizing from the right edge, including outside the modal
		const rect = $(this)[0].getBoundingClientRect();
		const clientX = e.type === 'touchstart' ? e.originalEvent.touches[0].clientX : e.clientX;

		if (clientX > rect.right - RESIZE_HOVER_AREA_WIDTH && clientX < rect.right + RESIZE_HOVER_AREA_WIDTH) {
			const modalElement = $(this); // Capture reference to the modal element
			isResizing = true;
			startMouseX = clientX;
			startWidth = rect.width;

			// Add temporary overlay to prevent text selection during drag
			const overlay = $('<div></div>').css({
				'position': 'fixed',
				'top': 0,
				'left': 0,
				'right': 0,
				'bottom': 0,
				'z-index': 1000,
				'cursor': 'ew-resize',
				'user-select': 'none',
				'-webkit-user-select': 'none',
				'-moz-user-select': 'none',
				'-ms-user-select': 'none'
			}).appendTo('body');

			// Add user-select: none to the modal content during drag
			modalElement.css({
				'user-select': 'none',
				'-webkit-user-select': 'none',
				'-moz-user-select': 'none',
				'-ms-user-select': 'none'
			});

			const moveHandler = function(e) {
				if (!isResizing) return;
					
				const currentX = e.type === 'touchmove' ? e.touches[0].clientX : e.clientX;
				const deltaX = currentX - startMouseX;
				let newWidth = startWidth + deltaX; // Calculate new width based on drag

				// Apply constraints
				const maxAllowedWidth = $(window).width() - (HORIZONTAL_SCREEN_PADDING * 2);
				newWidth = Math.max(MIN_DOC_MODAL_WIDTH, Math.min(newWidth, maxAllowedWidth)); // MAX_DOC_MODAL_WIDTH_ABSOLUTE is intentionally not applied

				modalElement.css('width', newWidth + 'px');
			};

			const endHandler = function() {
				if (!isResizing) return;
				isResizing = false;
				overlay.remove();
				modalElement.css({
					'user-select': '',
					'-webkit-user-select': '',
					'-moz-user-select': '',
					'-ms-user-select': ''
				});
				// Save the final width
				saveDocModalWidth(modalElement.width());
				// Remove event listeners
				$(document).off('mousemove touchmove', moveHandler);
				$(document).off('mouseup touchend', endHandler);
			};

			$(document).on('mousemove touchmove', moveHandler);
			$(document).on('mouseup touchend', endHandler);
		}
	});
};

const createDocModalHeader = () => {
	const modalHeader = $('<div class="wikivault-doc-modal-header"></div>')
		.appendTo(wikiVaultDocModal);

	wikiVaultDocModalTitle = $('<h2 id="wikivault-doc-modal-title"></h2>')
		.addClass('wikivault-doc-modal-title')
		.appendTo(modalHeader);

	// Icons will be added to the rightButtons container in setupTranslationUI

	return modalHeader;
};

const createDocModalContent = () => {
	wikiVaultDocModalContent = $('<div id="wikivault-doc-modal-content"></div>')
		.addClass('wikivault-doc-modal-content')
		.css({ // Maintain flex container for vertical layout
			'display': 'flex',
			'flex-direction': 'column',
			'gap': '0px' // Optional: add some space between the two areas
		})
		.appendTo(wikiVaultDocModal);

	const originalContentContainer = $('<div id="wikivault-original-content-container"></div>').css({
		'flex': '1', // Allow this container to take up space
		'min-height': '0', // Important for flex child
		'display': 'flex', // Use flex for original content (edit/read) layout
		'flex-direction': 'column',
		'gap': '0px'
	}).appendTo(wikiVaultDocModalContent);

	// Create container for edit area
	const editAreaContainer = $('<div></div>').addClass('wikivault-textarea-container').css({
		'flex': '1', // Take 50% of the height initially, but will adjust with flex
		'height': '50%', // Keep for initial sizing reference if needed, but flex will dominate
		'overflow-y': 'auto', // Add scrolling if content exceeds height
		'display': 'flex', // Use flex for textarea and icon
		'flex-direction': 'column', // Stack children vertically if needed, but here for height
		'position': 'relative' // Make this container the positioning context for the absolute copy icon
	}).appendTo(originalContentContainer);

	// Add resizable pane
	const resizablePane = $('<div></div>')
		.addClass('wikivault-resizable-pane')
		.appendTo(originalContentContainer);

	// Edit area
	const editArea = $('<textarea id="wikivault-doc-modal-edit"></textarea>')
		.addClass('wikivault-doc-modal-edit')
		.css({
			'flex': '1', // Allow textarea to fill container height
			'height': '100%', // Ensure textarea takes full height of its container
			'box-sizing': 'border-box' // Include padding and border in the element's total width and height
		});

	// Add copy icon to edit area container
	const editCopyIcon = createCopyIcon();

	// Append edit area and copy icon to its container
	editAreaContainer.append(editArea, editCopyIcon);

	// Read area
	const readArea = $('<div id="wikivault-doc-modal-read"></div>')
		.addClass('wikivault-doc-modal-read')
		.css({
			'flex': '1', // Take 50% of the height initially, but will adjust with flex
			'height': '50%', // Keep for initial sizing reference if needed, but flex will dominate
			'overflow-y': 'auto' // Add scrolling if content exceeds height
		})
		.on('click', 'a, button, input, [role="button"]', function(e) {
			e.preventDefault();
			return false;
		})
		.appendTo(originalContentContainer);

	// Create an inner wrapper for content inside readArea
	const readAreaInner = $('<div></div>').css({
		'padding': '10px', // Apply padding here
		'border': '1px solid #ddd', // Apply border here
		'border-radius': '5px', // Apply border-radius here
		'box-sizing': 'border-box', // Include padding and border in the element's total width and height
		'height': '100%', // Take full height of its parent (readArea)
		'overflow-y': 'auto' // Ensure scrolling for inner content
	}).appendTo(readArea);

	// Implement resizable pane functionality
	let isDragging = false;
	let startY;
	let startEditHeight;
	let startReadHeight;
	const minHeight = 100; // Minimum height for each area in pixels

	resizablePane.on('mousedown touchstart', function(e) {
		e.preventDefault(); // Prevent default selection
		isDragging = true;
		startY = e.type === 'touchstart' ? e.originalEvent.touches[0].clientY : e.clientY;
		startEditHeight = editAreaContainer.height();
		startReadHeight = readArea.height();
		// Capture the total available space for the two panes once at the start
		const availableSpaceForPanes = originalContentContainer.height() - resizablePane.height(); 
		
		// Add temporary overlay to prevent text selection during drag
		const overlay = $('<div></div>').css({
			'position': 'fixed',
			'top': 0,
			'left': 0,
			'right': 0,
			'bottom': 0,
			'z-index': 1000,
			'cursor': 'ns-resize',
			'user-select': 'none',
			'-webkit-user-select': 'none',
			'-moz-user-select': 'none',
			'-ms-user-select': 'none'
		}).appendTo('body');

		// Add user-select: none to the containers during drag
		editAreaContainer.css({
			'user-select': 'none',
			'-webkit-user-select': 'none',
			'-moz-user-select': 'none',
			'-ms-user-select': 'none'
		});
		readArea.css({
			'user-select': 'none',
			'-webkit-user-select': 'none',
			'-moz-user-select': 'none',
			'-ms-user-select': 'none'
		});

		// Use addEventListener for touch events
		const moveHandler = function(e) {
			if (!isDragging) return;
			e.preventDefault(); // Prevent default selection during drag

			const currentY = e.type === 'touchmove' ? e.touches[0].clientY : e.clientY;
			const deltaY = currentY - startY;

			let proposedEditHeight = startEditHeight + deltaY;

			// Add minimum height constraint (20% of available space)
			const minEditHeight = availableSpaceForPanes * 0.2;
			// Ensure finalEditHeight stays within the bounds of minEditHeight and availableSpaceForPanes
			let finalEditHeight = Math.max(minEditHeight, Math.min(proposedEditHeight, availableSpaceForPanes));

			let finalReadHeight = availableSpaceForPanes - finalEditHeight; // The remaining space

			// Calculate percentages based on the total height available for both panes
			const editPercentage = (finalEditHeight / availableSpaceForPanes) * 100;
			const readPercentage = (finalReadHeight / availableSpaceForPanes) * 100;

			// Update heights
			editAreaContainer.css('flex', `${editPercentage}%`);
			readArea.css('flex', `${readPercentage}%`);

			// Update WikiEditor bottom bar height
			adjustWikiEditorHeight();
		};

		const endHandler = function() {
			isDragging = false;
			overlay.remove();
			
			// Restore user-select to auto
			editAreaContainer.css({
				'user-select': 'auto',
				'-webkit-user-select': 'auto',
				'-moz-user-select': 'auto',
				'-ms-user-select': 'auto'
			});
			readArea.css({
				'user-select': 'auto',
				'-webkit-user-select': 'auto',
				'-moz-user-select': 'auto',
				'-ms-user-select': 'auto'
			});
			
			// Remove event listeners
			document.removeEventListener('mousemove', moveHandler);
			document.removeEventListener('touchmove', moveHandler, { passive: false });
			document.removeEventListener('mouseup', endHandler);
			document.removeEventListener('touchend', endHandler);
		};

		// Add event listeners
		document.addEventListener('mousemove', moveHandler);
		document.addEventListener('touchmove', moveHandler, { passive: false });
		document.addEventListener('mouseup', endHandler);
		document.addEventListener('touchend', endHandler);
	});

	// Setup auto-update preview on input with debounce
	let debounceTimer;
	editArea.on('input', function() {
		clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			updatePreview(false);
		}, 1000); // 1 second debounce
	});

	// Add click handler to copy icon (moved here)
	editCopyIcon.on('click', () => copyTextToClipboard(editArea.val()));

	const optionsContentContainer = $('<div id="wikivault-options-content-container"></div>').css({
		'flex': '1', // Allow this container to take up space
		'min-height': '0', // Important for flex child
		'overflow-y': 'auto', // Add scrolling if content exceeds height
		'padding': '20px' // Add padding similar to writing container
	}).appendTo(wikiVaultDocModalContent).hide(); // Append to main content area and initially hide

	// Add content structure to options container
	optionsContentContainer.append(`
		<div class="wikivault-settings-section" style="margin-bottom: 20px;">
			<p class="wikivault-settings-title">번역 옵션</p>
			<div class="wikivault-settings-content">
				<div class="wikivault-settings-item">
					<label class="wikivault-settings-label" style="white-space: nowrap;">한국어 제목　</label>
					<input type="text" id="wikivault-korean-title-input" class="wikivault-setting-input" placeholder="한국어 제목을 입력하세요" style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; box-sizing: border-box;" autocomplete="off">
				</div>
				<div class="wikivault-settings-item">
					<label class="wikivault-settings-label" style="white-space: nowrap;">추가 요청사항</label>
					<textarea id="wikivault-translation-request-textarea" class="wikivault-setting-input" placeholder="번역을 위해 추가로 요청할 사항을 입력하세요." rows="5" style="width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; resize: none; box-sizing: border-box;"></textarea>
				</div>
				<div class="wikivault-settings-item" style="display: flex; align-items: center;">
					<input type="checkbox" id="wikivault-fast-google-checkbox" class="wikivault-setting-input" style="margin-right: 8px; margin-top: 0; margin-bottom: 0;">
					<label for="wikivault-fast-google-checkbox" style="cursor: pointer; margin: 0;">
						고속 번역: 레거시 모델 사용 (권장하지 않음)
					</label>
				</div>
			</div>
		</div>
		<p style='font-size: 90%; margin-top: 10px;'><span class='warning-icon'>⚡</span>위의 모든 내용은 선택사항이며, AI가 참고합니다.</p>
	`);

	// Add logic to enable/disable fields based on checkbox
	optionsContentContainer.on('change', '#wikivault-fast-google-checkbox', function() {
		const checked = $(this).is(':checked');
		$('#wikivault-korean-title-input').prop('disabled', checked);
		$('#wikivault-translation-request-textarea').prop('disabled', checked);
	});
};

const createDocModalCloseButton = () => {
	return $('<div id="wikivault-doc-modal-close-btn"></div>')
		.addClass('wikivault-doc-modal-close-btn')
		.html(
			'<svg style="fill: var(--color-base, #202122);" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">' +
			'<path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>' +
			'</svg>'
		);
};

const setupDocModalTabs = () => {
	const tabContainer = $('<div class="wikivault-doc-modal-tabs"></div>')
		.appendTo(wikiVaultDocModal);

	// Create tab buttons
	const originalTab = $('<button>원문</button>')
		.attr('id', 'wikivault-doc-modal-tab-original')	
		.addClass('wikivault-doc-modal-tab wikivault-doc-modal-tab-active')
		.appendTo(tabContainer);

	const optionsTab = $('<button>번역 옵션</button>') // Options tab
		.addClass('wikivault-doc-modal-tab')
		.appendTo(tabContainer);

	// Add click handlers for tabs
	originalTab.on('click', function() {
		if ($(this).hasClass('wikivault-doc-modal-tab-active')) return;
		originalTab.addClass('wikivault-doc-modal-tab-active');
		optionsTab.removeClass('wikivault-doc-modal-tab-active');
		$('#wikivault-original-content-container').show(); // Show original content
		$('#wikivault-options-content-container').hide(); // Hide options content
	});

	optionsTab.on('click', function() {
		if ($(this).hasClass('wikivault-doc-modal-tab-active')) return;
		optionsTab.addClass('wikivault-doc-modal-tab-active');
		originalTab.removeClass('wikivault-doc-modal-tab-active');
		$('#wikivault-original-content-container').hide(); // Hide original content
		$('#wikivault-options-content-container').show(); // Show options content
	});
};

const saveDocModalWidth = (width) => {
	localStorage.setItem('wikivault_doc_modal_width', width);
};

const loadDocModalWidth = () => {
	const savedWidth = localStorage.getItem('wikivault_doc_modal_width');
	let width = DEFAULT_DOC_MODAL_WIDTH;

	if (savedWidth) {
		width = parseInt(savedWidth, 10);
		// Ensure the loaded width does not exceed the current browser width minus padding
		const maxAllowedWidth = $(window).width() - (HORIZONTAL_SCREEN_PADDING * 2);
		width = Math.min(width, maxAllowedWidth);
	}

	return Math.max(MIN_DOC_MODAL_WIDTH, width);
};

const showDocModal = (title) => {
	disableMainModal();

	mw.loader.using( [
		'ext.wikiEditor'
	] ).then( ( require ) => {
		if (!$('#wikivault-doc-modal-edit').parent().hasClass("wikiEditor-ui-text")) {
			const textarea = document.getElementById( 'wikivault-doc-modal-edit' );
			mw.addWikiEditor( $( textarea ) );
			// Adjust height after adding the editor
			adjustWikiEditorHeight();
			$('#wikivault-doc-modal').off('mouseup', '.tab a');
			$('#wikivault-doc-modal').on('mouseup', '.tab a', function(e) {
				e.preventDefault();
				setTimeout(function() {
					adjustWikiEditorHeight();
				}, 0);
			});	
		}
	} );

	// Reset buttons
	saveTranslationBtn.hide();
	aiTranslateBtn.show(); // AI Translate button is initially shown and enabled after fetch
	disableButtons();

	// Show main document UI (controlled by CSS/flexbox now)
	$('.wikivault-doc-modal-tabs').show(); // The single '원문' tab container
	wikiVaultDocModalContent.show(); // The main content area container

	// Clear edit area and show loading in read area
	$('#wikivault-doc-modal-edit').val('');
	$('#wikivault-doc-modal-read').empty().show(); // Ensure read area is shown
	$('#wikivault-doc-modal-read').append(
		$('<div class="loading-dots"><span></span><span></span><span></span></div>')
	);

	// Uncheck fast-google-checkbox
	$('#wikivault-fast-google-checkbox').prop('checked', false);
	$('#wikivault-korean-title-input').prop('disabled', false);
	$('#wikivault-translation-request-textarea').prop('disabled', false);

	wikiVaultDocModal.show();
	// Apply saved width
	const loadedWidth = loadDocModalWidth();
	wikiVaultDocModal.css('width', loadedWidth + 'px');
	wikiVaultDocModalTitle.text(title);

	// Remove existing indicators if any
	wikiVaultDocModal.find('.ko-wiki-modal-existence-indicator, .ko-wiki-modal-mode').remove();

	// Check Korean Wikipedia existence
	checkKoreanWikiExistence(title).then(existenceData => {
		// Create and add new indicator
		const indicator = createModalExistenceIndicator(existenceData[title], false);
		wikiVaultDocModal.append(indicator);

		// Automatically populate korean_title if a Korean version exists
		if (existenceData[title] && existenceData[title].exists && existenceData[title].koTitle) {
			$('#wikivault-korean-title-input').val(existenceData[title].koTitle);
		}
	});

	// Add mode indicator
	const modeIndicator = createModeIndicator(false);
	wikiVaultDocModal.append(modeIndicator);

	// Explicitly hide the translation container when showing the document modal
	if (wikiVaultTranslationContainer) { // Add check if defined
        wikiVaultTranslationContainer.hide();

        // Also ensure the content within is reset when the modal is opened again
        // This is safer to do here after checking if the container exists
        wikiVaultTranslationContainer.find('#wikivault-translated-content').val(''); // Clear textarea
        wikiVaultTranslationContainer.find('#wikivault-translation-loading').hide(); // Hide loading
        wikiVaultTranslationContainer.data('previewArea').empty().hide(); // Clear & hide preview
        wikiVaultTranslationContainer.data('sideBySideContainer').hide(); // Hide side-by-side
        wikiVaultTranslationContainer.data('originalTextarea').val(''); // Clear original in side-by-side
        wikiVaultTranslationContainer.find('.wikivault-copy-icon').hide(); // Hide copy icons
    }

	// Trigger initial preview update for the original text
	updatePreview(true);

	$('#wikivault-korean-title-input').val('');
	$('#wikivault-translation-request-textarea').val('');
	$('#wikivault-doc-modal-tab-original').trigger('click');

	fetchWikiText(title)
		.then(handleWikiTextSuccess)
		.catch(handleWikiTextError);
};

const handleWikiTextSuccess = (response) => {
	if (response.error) {
		handleWikiTextError(response.error);
		return;
	}

	currentWikiText = response.parse.wikitext['*'];
	$('#wikivault-doc-modal-edit').val(currentWikiText);

	enableButtons(); // Enable relevant buttons like AI Translate
};

const handleWikiTextError = (error) => {
	console.error('Failed to fetch wiki text:', error);

	// Update both areas to indicate error
	$('#wikivault-doc-modal-edit').val('[Error: 문서를 불러오는데 실패했습니다]');
	$('#wikivault-doc-modal-read').html(
		'<div style="color: red; padding: 20px;">❌ 문서를 불러오는데 실패했습니다.</div>'
	);

	disableButtons(); // Disable AI Translate button
};

const updatePreview = (isCached) => {
	const readArea = $('#wikivault-doc-modal-read');
	readArea.empty();
	
	const loadingDots = $('<div class="loading-dots"><span></span><span></span><span></span></div>');
	readArea.append(loadingDots);

	addLoadingAnimation();

	if (isCached) {
		const params = {
			format: 'json',
			action: 'parse',
			page: wikiVaultDocModalTitle.text(),
			prop: 'text|categorieshtml|langlinks',
			origin: '*',
			disableeditsection: true
		};
		
		$.get(CONSTANTS.API.WIKIPEDIA_EN, params)
			.done((data) => handlePreviewSuccess(readArea)(data))
			.fail((err) => handlePreviewError(readArea)(err));
		return;
	}

	const api = new mw.ForeignApi(CONSTANTS.API.WIKIPEDIA_EN);
	const params = {
		format: 'json',
		action: 'parse',
		preview: true,
		disableeditsection: true,
		pst: true,
		title: wikiVaultDocModalTitle.text(),
		text: $('#wikivault-doc-modal-edit').val(),
		prop: 'text|categorieshtml|langlinks'
	};

	api.post(params)
		.then(handlePreviewSuccess(readArea))
		.catch(handlePreviewError(readArea));
};

const addLoadingAnimation = () => {
	const style = $('<style>').text(`
		.loading-dots {
			display: flex;
			justify-content: center;
			align-items: center;
			height: 100%;
			min-height: 100px;
		}
		.loading-dots span {
			width: 12px;
			height: 12px;
			margin: 0 6px;
			border-radius: 50%;
			background-color: var(--color-base, #202122);
			display: inline-block;
			animation: dots 1.4s infinite ease-in-out both;
		}
		.loading-dots span:nth-child(1) { animation-delay: -0.32s; }
		.loading-dots span:nth-child(2) { animation-delay: -0.16s; }
		.loading-dots span:nth-child(3) { animation-delay: 0s; }
		@keyframes dots {
			0%, 80%, 100% { 
				transform: scale(0);
				opacity: 0.3;
			}
			40% { 
				transform: scale(1);
				opacity: 1;
			}
		}
	`);
	$('head').append(style);
};

const handlePreviewSuccess = (readArea) => (data) => {
    const wrapperClass = 'read-area-wrapper'; // Unique wrapper class
    const htmlText = `<div class="${wrapperClass}">` + 
        data.parse.text['*'] + 
        data.parse.categorieshtml["*"] + 
        '</div>';
    
    readArea.empty().html(htmlText);

    // Scope styles to the inside of readArea only
    readArea.find('style[data-mw-deduplicate]').each(function () {
        const originalCSS = $(this).text();
        const scopedCSS = originalCSS.replace(/\.mw-parser-output/g, `.${wrapperClass} .mw-parser-output`);
        $(this).text(scopedCSS);
    });

    readArea.find('a, button, input, [role="button"]').css({
        'pointer-events': 'none',
        'cursor': 'default'
    }).on('click', function (e) {
        e.preventDefault();
        return false;
    });
};

const handlePreviewError = (readArea) => () => {
	readArea.empty();
	readArea.html('<div style="color: red;">❌ 미리보기를 불러오는데 실패했습니다.</div>');
};

const createModalExistenceIndicator = (existenceData, isTranslationMode = false) => {
	if (!existenceData) return $('<div>').css('display', 'none');

	const container = $('<div>')
		.addClass('ko-wiki-modal-indicator-container')
		.addClass('ko-wiki-modal-existence-indicator')
		.css({
			'position': 'absolute',
			'top': '0px',
			'left': isTranslationMode ? '45px' : '14px',
			'display': 'flex',
			'flex-direction': 'row',
			'align-items': 'center',
			'gap': '8px',
			'z-index': '1005'
		});

	const indicator = $('<div class="ko-wiki-indicator"></div>')
		.text(existenceData.exists ? '한국어로 있음' : '한국어로 없음')
		.css({
			'padding': '4px 8px',
			'border-radius': '4px',
			'font-size': '12px',
			'font-weight': 'bold',
			'cursor': 'pointer'
		});
  
	const indicatorEl = indicator[0];
	indicatorEl.style.setProperty(
		'background-color',
		existenceData.exists
			? 'var(--background-color-success-subtle, #dff2eb)'
			: 'var(--background-color-destructive-subtle, #ffe9e5)'
	);
	indicatorEl.style.setProperty(
		'color',
		existenceData.exists
			? 'var(--color-success, #177860)'
			: 'var(--color-destructive, #bf3c2c)'
	);

	// Add language count indicator
	const langCountIndicator = $('<div>')
		.css({
			'font-size': '10px',
			'color': 'inherit',
			'margin-top': '2px'
		})
		.text(`+${existenceData.langCount}개 언어로 작성됨`);

	container.append(indicator);
	container.append(langCountIndicator);

	// Add click handler for both cases
	indicator.on('click', (e) => {
		e.stopPropagation(); // Prevent triggering parent's click event
		let url;
		if (existenceData.exists && existenceData.koTitle) {
			url = `https://ko.wikipedia.org/wiki/${encodeURIComponent(existenceData.koTitle)}`;
		} else {
			url = `https://ko.wikipedia.org/wiki/Special:Search/${encodeURIComponent(existenceData.title)}`;
		}
		window.open(url, '_blank');
	});

	// Add tooltip
	if (existenceData.exists && existenceData.koTitle) {
		indicator.attr('title', existenceData.koTitle);
	} else {
		indicator.attr('title', '한국어 위키백과에서 검색');
	}

	return container;
};

const createModeIndicator = (isTranslationMode) => {
	const indicator = $('<div class="ko-wiki-modal-mode"></div>')
	.text(isTranslationMode ? '● 번역 편집 모드' : '● 번역 준비 모드')
	.css({
	  'position': 'absolute',
	  'top': '0px',
	  'right': '14px',
	  'padding': '4px 8px',
	  'border-radius': '4px',
	  'font-size': '12px',
	  'font-weight': 'bold',
	  'cursor': 'default',
	  'z-index': '1005'
	});
  
	indicator[0].style.setProperty(
		'color',
		isTranslationMode
		  ? 'var(--color-success, #177860)'
		  : 'var(--color-destructive--focus, #36c)'
	);  
	return indicator;
};

//#endregion


//#region 08. Translation — Translation tab, translation UI, translation progress

const setupTranslationTab = (tabContent) => {
	const searchContainer = createSearchContainer();
	tabContent.append("<p style='font-size: 90%;'><b>번역할 항목을 찾기</b> (영어 위키백과에서 찾기)</p>");
	tabContent.append(searchContainer);

	const searchResults = $('<div id="wikivault-search-results"></div>').css({
		'margin-top': '10px'
	});
	tabContent.append(searchResults);
	if ($('.interwiki-en a').length) {
		const dataTitle = $($('.interwiki-en a')[0]).attr('data-title');
		if (dataTitle.length) {
			tabContent.append('<span id="wikivault-did-you-mean" style="font-size: 80%; margin-bottom: 10px; display: block;">이것을 찾으셨나요?&nbsp;<a href="#" class="wikivault-suggested-title" style="color: #007bff; text-decoration: underline; cursor: pointer;">' + dataTitle + '</a></span>');
			$('.wikivault-suggested-title').on('click', function(e) {
				e.preventDefault();
				const input = $($('.wikivault-search-input')[0]).find('input');
				input.val(dataTitle).trigger('input');
			});
		}
	}
	tabContent.append("<div id='wikivault-suggestion-divider' style='border-top: 1px solid #e0e0e0; margin: 20px 0 10px 0;'></div><p id='wikivault-suggestion-title' style='font-size: 90%; font-weight: bold; margin-top: 20px;'>번역 생성 제안</p>");
	const suggestedPagesContainer = createSuggestedPagesContainer();
	tabContent.append(suggestedPagesContainer);
	tabContent.append(`
		<div id='wikivault-useful-links-divider' style='border-top: 1px solid #e0e0e0; margin: 20px 0 10px 0;'></div><p id='wikivault-useful-links-title' style='font-size: 90%; font-weight: bold; margin-top: 20px;'>유용한 링크</p>
		<ul id='wikivault-useful-links-list' style='font-size: 80%; margin-left: 0; list-style-type: none; padding-left: 0; display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px;'>
			<li class="wikivault-link-card"><a href="https://ko.wikipedia.org/wiki/위키백과:데이터베이스_보고서/번역이_필요한_짧은_문서" target="_blank" rel="noopener noreferrer">번역이 필요한 짧은 문서<br>(문서 보강 대상)</a></li>
			<li class="wikivault-link-card"><a href="https://stats.wikimedia.org/#/ko.wikipedia.org/reading/top-viewed-articles/normal|table|last-month|(access)~desktop*mobile-app*mobile-web|daily" target="_blank" rel="noopener noreferrer">가장 많이 읽은 문서<br>(문서 보강 대상)</a></li>
			<li class="wikivault-link-card"><a href="https://ko.wikipedia.org/wiki/위키백과:문서_작성_요청" target="_blank" rel="noopener noreferrer">문서 작성 요청</a></li>
		</ul>
	`);
	tabContent.append("<div id='wikivault-translation-warning-divider' style='border-top: 1px solid #e0e0e0; margin: 20px 0 10px 0;'></div><p id='wikivault-translation-warning-message' style='font-size: 80%;'><span class='warning-icon'>&#9889;</span>번역의 결과물은 사용자의 확인이 필요합니다.</p>");

	fetchSuggestedPages();
	setupSearchHandlers(searchResults, suggestedPagesContainer);
};

const setupTranslationUI = (modalHeader) => {
	backButton = createBackButton();
	wikiVaultTranslationContainer = createTranslatedContent();
	translatedContent = wikiVaultTranslationContainer.find('#wikivault-translated-content');  // Store textarea reference

	// Add WikiEditor to the translated content textarea
	mw.loader.using( [
		'ext.wikiEditor'
	] ).then( ( require ) => {
		mw.addWikiEditor( $( translatedContent ) );
		// Find the WikiEditor's text area wrapper
		const wikiEditorTextWrapper = translatedContent.closest('.wikiEditor-ui-text');

		// Create and append the copy icon to the WikiEditor's text wrapper
		const translatedCopyIcon = createCopyIcon();
		if (wikiEditorTextWrapper.length) {
			wikiEditorTextWrapper.append(translatedCopyIcon);
			translatedCopyIcon.on('click', () => copyTextToClipboard(translatedContent.val()));
		}

		// Adjust height after adding the editor
		adjustWikiEditorHeight();
		$('#wikivault-doc-modal').off('mouseup', '.tab a');
		$('#wikivault-doc-modal').on('mouseup', '.tab a', function(e) {
			e.preventDefault();
			setTimeout(function() {
				adjustWikiEditorHeight();
			}, 0);
		});
	} );

	aiTranslateBtn = createTranslateButton();
	saveTranslationBtn = createSaveButton();
	wikiVaultDocModalCloseBtn = createDocModalCloseButton();

	modalHeader.prepend(backButton);
	wikiVaultDocModal.append(wikiVaultTranslationContainer);

	// Create a container for the right-side buttons to ensure proper alignment
	const rightButtons = $('<div class="modal-right-buttons"></div>').css({
		'display': 'flex',
		'align-items': 'center',
		'margin-left': 'auto'  // Push to the right
	});

	// Icon dropdown menu
	const dropdownContainer = $('<div></div>').css({
		'position': 'relative', // For positioning the dropdown menu
		'display': 'inline-block',
		'margin-right': '10px' // Space between dropdown and other buttons
	});

	const dropdownButton = $('<button class="wikivault-icon-dropdown-button">▼</button>')
	.css({
	  'background': 'none',
	  'border-radius': '4px',
	  'padding': '4px 8px',
	  'cursor': 'pointer',
	  'font-size': '16px',
	  'line-height': '1',
	  'height': '32px',
	  'display': 'flex',
	  'align-items': 'center',
	  'justify-content': 'center'
	});
  
	const buttonEl = dropdownButton[0];
	buttonEl.style.setProperty('border', '1px solid var(--border-color-base, #a2a9b1)');
	buttonEl.style.setProperty('color', 'var(--color-base, #202122)');

	const dropdownMenu = $('<div></div>')
	.addClass('wikivault-icon-dropdown-menu')
	.css({
	  'position': 'absolute',
	  'top': '100%',
	  'right': '0',
	  'border-radius': '4px',
	  'box-shadow': '0 2px 5px rgba(0,0,0,0.2)',
	  'z-index': '1006',
	  'display': 'none',
	  'min-width': '150px',
	  'padding': '5px 0'
	});
  
	const menuEl = dropdownMenu[0];
	menuEl.style.setProperty('background', 'var(--background-color-base, #fff)');
	menuEl.style.setProperty('border', '1px solid var(--border-color-base, #a2a9b1)');

	// Add items to the dropdown menu
	const addDropdownItem = (text, onClick) => {
		const item = $('<div></div>')
			.addClass('wikivault-dropdown-item')
			.text(text)
			.css({
				'padding': '8px 15px',
				'cursor': 'pointer',
				'font-size': '90%'
			})
			.hover(
				function () {
					$(this)[0].style.setProperty('background-color', 'var(--background-color-neutral-subtle, #f8f9fa)');
				},
				function () {
					$(this).css('background-color', 'transparent');
				}
			)
			.on('click', function () {
				onClick();
				dropdownMenu.hide();
			});
	
		// Apply only styles containing CSS variables via setProperty
		item[0].style.setProperty('color', 'var(--color-base, #202122)');
	
		dropdownMenu.append(item);
	};

	// Define actions and add items
	addDropdownItem('제목 복사', () => copyTextToClipboard(wikiVaultDocModalTitle.text()));
	const translateTitle = async () => {
		//const title = wikiVaultDocModalTitle.text();
		const title = wikiVaultDocModalTitle.html();
		if (!title) {
			mw.notify('번역할 제목이 없습니다.', { type: 'error' });
			return;
		}

		try {
			const response = await fetch(CONSTANTS.API.MAIN_URI + CONSTANTS.API.FASTTRANSLATE_ENDPOINT, {
				method: 'POST',
				headers: wikiVaultAuth.headers({ 'Content-Type': 'application/json' }),
				body: JSON.stringify({
					username: wgUserName,
					prompt: title
				})
			});

			if (response.status === 401) {
				wikiVaultAuth.handleUnauthorized();
				return;
			}
			const data = await response.json();
			if (data.error) {
				throw new Error(data.error);
			}

			const translatedTitle = data.translatedText;
			const result = confirm(`번역된 제목: ${translatedTitle}\n\n복사하시겠습니까?`);
			
			if (result) {
				await copyTextToClipboard(translatedTitle);
				mw.notify('번역된 제목이 클립보드에 복사되었습니다.', { type: 'success' });
			}
		} catch (error) {
			mw.notify('번역 중 오류가 발생했습니다: ' + error.message, { type: 'error' });
		}
	};
	addDropdownItem('제목 번역하기', () => wikiVaultAuth.ensureLogin(translateTitle));
	addDropdownItem('영어 위키백과에서 보기', () => {
		const title = wikiVaultDocModalTitle.text();
		if (title) {
			window.open('https://en.wikipedia.org/wiki/' + encodeURIComponent(title), '_blank');
		}
	});
	addDropdownItem('위키데이터에서 보기', async () => {
		const title = wikiVaultDocModalTitle.text();
		if (title) {
			const wikidataId = await fetchWikidataId(title);
			if (wikidataId) {
				window.open(`https://www.wikidata.org/wiki/Special:EntityPage/${wikidataId}`, '_blank');
			} else {
				mw.notify('위키데이터 ID를 찾을 수 없습니다.', { type: 'error' });
			}
		}
	});
	addDropdownItem('네이버에서 찾기', () => {
		const title = wikiVaultDocModalTitle.text();
		if (title) {
			window.open('https://search.naver.com/search.naver?query=' + encodeURIComponent(title), '_blank');
		}
	});
	addDropdownItem('구글에서 찾기', () => {
		const title = wikiVaultDocModalTitle.text();
		if (title) {
				window.open('https://www.google.com/search?q=' + encodeURIComponent(title), '_blank');
		}
	});


	// Toggle dropdown visibility
	dropdownButton.on('click', (e) => {
		e.stopPropagation(); // Prevent modal close if clicked inside
		dropdownMenu.toggle();
	});

	// Hide dropdown when clicking outside
	$(document).on('click', (e) => {
		if (!$(e.target).closest('.wikivault-icon-dropdown-container').length) {
			dropdownMenu.hide();
		}
	});

	dropdownContainer.append(dropdownButton, dropdownMenu);

	// Initially hide save button
	saveTranslationBtn.hide();

	// Append the new dropdown container and existing buttons to the rightButtons container
	rightButtons.append(dropdownContainer, aiTranslateBtn, saveTranslationBtn, wikiVaultDocModalCloseBtn);

	modalHeader.append(rightButtons);

	setupTranslationEventHandlers();
	setupSaveButtonHandler();
};

const createBackButton = () => {
	return $('<div class="back-button"><svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg></div>')
		.css({
			cursor: 'pointer',
			display: 'none',
			marginRight: '10px',
			position: 'absolute',
			top: '0px',
			left: '14px',
			zIndex: '1005',
			'background-color': 'transparent',
			'border-radius': '4px',
			'padding': '4px',
			'transition': 'background-color 0.2s'
		})
		.hover(
			function() { $(this)[0].style.setProperty('background-color', 'var(--background-color-neutral-subtle, #f8f9fa)'); },
			function() { $(this).css('background-color', 'transparent'); }
		);
};

const createTranslatedTabContainer = () => {
	const container = $('<div></div>') // Use a container for both tab and content
		.css({
			display: 'none' // Initially hidden
		});

	const tabContainer = $('<div class="translation-tab-container"></div>')
		.css({
			borderBottom: '1px solid #ddd',
			marginBottom: '15px',
			marginTop: '10px',
			display: 'none'  // This will be controlled by the parent container
		});

	const translatedContentArea = createTranslatedContent(); // This already returns the full content structure

	container.append(translatedContentArea);

	// Store references to elements needed by handlers
	container.data('viewToggle', translatedContentArea.data('viewToggle'));
	container.data('previewArea', translatedContentArea.data('previewArea'));
	container.data('sideBySideContainer', translatedContentArea.data('sideBySideContainer'));
	container.data('originalTextarea', translatedContentArea.data('originalTextarea'));

	return container;
};

const createTranslatedContent = () => {
    const container = $('<div></div>').css({
        'display': 'flex',
        'flex-direction': 'column',
        'height': 'calc(100% - 60px)', // Adjusted to prevent overflow
        'gap': '0px'
    });

    // Add toggle switch for view mode
    const viewToggleContainer = $('<div></div>').css({
        'display': 'flex',
        'align-items': 'center',
        'margin-bottom': '10px',
        'font-size': 'smaller',
        'gap': '0px'
    });

    const previewLabel = $('<label>미리 보기</label>');
    const compareLabel = $('<label>원문 원본과 비교하기</label>');
    const descriptiveLabel = $('<label>미리 보기 (꺼져 있으면 원본 비교 모드)</label>');

    const viewToggleSwitch = new OO.ui.ToggleSwitchWidget({
        value: false
    });

    // Append elements in the desired order
    viewToggleContainer.append(previewLabel.$element, viewToggleSwitch.$element, descriptiveLabel, compareLabel.$element);

    // Create container for the translated textarea
    const translatedTextareaContainer = $('<div></div>').addClass('wikivault-textarea-container').css({
        'flex': '1',
        'min-height': '0',
        'display': 'flex',
        'flex-direction': 'column',
        'position': 'relative'
    });

    // Create the translated textarea
    const translatedTextarea = $('<textarea id="wikivault-translated-content"></textarea>')
        .addClass('wikivault-doc-modal-edit')
        .css({
            'flex': '1',
            'height': '100%',
            'box-sizing': 'border-box'
        });

    // Add copy icon to translated textarea container
    const translatedCopyIcon = createCopyIcon();
    translatedTextareaContainer.append(translatedTextarea, translatedCopyIcon);
    translatedCopyIcon.on('click', () => copyTextToClipboard(translatedTextarea.val()));

    // Add resizable pane
    const resizablePane = $('<div></div>')
        .addClass('wikivault-resizable-pane')
        .appendTo(container);

    // Create container for the lower view (preview or side-by-side)
    const lowerViewContainer = $('<div id="wikivault-lower-view-container"></div>').css({
        'flex': '1',
        'min-height': '0',
        'display': 'flex',
        'gap': '0px',
        'overflow': 'hidden',
        'box-sizing': 'border-box' // Prevent overflow
    }).appendTo(container);

    // Create inner wrapper for lowerViewContainer
    const lowerViewInnerWrapper = $('<div></div>').css({
        'flex': '1',
        'height': '100%',
        'display': 'flex',
        'gap': '0px',
        'padding': '10px',
        'border': '1px solid #ddd',
        'border-radius': '5px',
        'box-sizing': 'border-box',
        'overflow': 'hidden'
    }).appendTo(lowerViewContainer);

    // Preview area (initially hidden, will be managed by the toggle)
    const previewArea = $('<div id="wikivault-translated-preview"></div>').css({
        'flex': '1',
        'min-height': '0',
        'overflow-y': 'auto',
        'user-select': 'text',
        'pointer-events': 'auto',
        'cursor': 'default',
        'display': 'none'
    });

    // Side-by-side container (initially shown, will be managed by the toggle)
    const sideBySideContainer = $('<div></div>').css({
        'display': 'flex',
        'flex': '1',
        'min-height': '0',
        'gap': '0px',
        'overflow': 'hidden'
    });

    // Original textarea (for side-by-side view)
	const originalTextarea = $('<textarea readonly id="wikivault-original-content"></textarea>')
	.addClass('wikivault-doc-modal-edit')
	.css({
	  'min-height': '0',
	  'resize': 'none',
	  'height': '100%'
	});
  
	originalTextarea[0].style.setProperty(
		'background-color',
		'var(--background-color-neutral-subtle, #f8f9fa)'
	);

    const originalCopyIcon = createCopyIcon();
    const originalContainer = $('<div></div>').addClass('wikivault-textarea-container').css({'flex': '1'}).append(originalTextarea, originalCopyIcon);
    originalCopyIcon.on('click', () => copyTextToClipboard(originalTextarea.val()));

    sideBySideContainer.append(originalContainer);

    // Append preview and side-by-side containers to the lower view container
    lowerViewInnerWrapper.append(previewArea, sideBySideContainer); // Append to inner wrapper

    // Append all containers to the main container
    container.append(viewToggleContainer, translatedTextareaContainer, resizablePane, lowerViewContainer);

    // Store references to elements needed by handlers
    container.data('viewToggle', viewToggleSwitch);
    container.data('previewArea', previewArea);
    container.data('sideBySideContainer', sideBySideContainer);
    container.data('originalTextarea', originalTextarea);
    container.data('viewToggleContainer', viewToggleContainer);
    container.data('translatedTextareaContainer', translatedTextareaContainer);
    container.data('lowerViewContainer', lowerViewContainer);
    container.data('lowerViewInnerWrapper', lowerViewInnerWrapper); // Store reference to inner wrapper

    // Initially hide all translation UI elements
    viewToggleContainer.hide();
    translatedTextareaContainer.hide();
    lowerViewContainer.hide();

    // Implement resizable pane functionality
    let isDragging = false;
    let startY;
    let startTranslatedHeight;
    let startLowerHeight;
    const minHeight = 100; // Minimum height for each area in pixels

    resizablePane.on('mousedown touchstart', function(e) {
        e.preventDefault();
        isDragging = true;
        startY = e.type === 'touchstart' ? e.originalEvent.touches[0].clientY : e.clientY;
        startTranslatedHeight = translatedTextareaContainer.height();
        startLowerHeight = lowerViewContainer.height();
        // Calculate available space once at the start, including viewToggleContainer height
        const availableSpaceForPanes = container.height() - viewToggleContainer.outerHeight(true) - resizablePane.height();
        
        // Add temporary overlay to prevent text selection during drag
        const overlay = $('<div></div>').css({
            'position': 'fixed',
            'top': 0,
            'left': 0,
            'right': 0,
            'bottom': 0,
            'z-index': 1000,
            'cursor': 'ns-resize',
            'user-select': 'none',
            '-webkit-user-select': 'none',
            '-moz-user-select': 'none',
            '-ms-user-select': 'none'
        }).appendTo('body');

        // Add user-select: none to the containers during drag
        translatedTextareaContainer.css({
            'user-select': 'none',
            '-webkit-user-select': 'none',
            '-moz-user-select': 'none',
            '-ms-user-select': 'none'
        });
        lowerViewContainer.css({
            'user-select': 'none',
            '-webkit-user-select': 'none',
            '-moz-user-select': 'none',
            '-ms-user-select': 'none'
        });

        // Use addEventListener for touch events
        const moveHandler = function(e) {
            if (!isDragging) return;
            e.preventDefault();

            const currentY = e.type === 'touchmove' ? e.touches[0].clientY : e.clientY;
            const deltaY = currentY - startY;

            let proposedTranslatedHeight = startTranslatedHeight + deltaY;

            // Add minimum height constraint (20% of available space)
            const minTranslatedHeight = availableSpaceForPanes * 0.2;
            // Ensure finalTranslatedHeight stays within the bounds of minTranslatedHeight and availableSpaceForPanes
            let finalTranslatedHeight = Math.max(minTranslatedHeight, Math.min(proposedTranslatedHeight, availableSpaceForPanes));

            let finalLowerHeight = availableSpaceForPanes - finalTranslatedHeight; // The remaining space

            // Calculate percentages
            const translatedPercentage = (finalTranslatedHeight / availableSpaceForPanes) * 100;
            const lowerPercentage = (finalLowerHeight / availableSpaceForPanes) * 100;

            // Update heights
            translatedTextareaContainer.css('flex', `${translatedPercentage}%`);
            lowerViewContainer.css('flex', `${lowerPercentage}%`);

            // Update WikiEditor bottom bar height
            adjustWikiEditorHeight();
        };

        const endHandler = function() {
            isDragging = false;
            overlay.remove();
            
            // Restore user-select to auto
            translatedTextareaContainer.css({
                'user-select': 'auto',
                '-webkit-user-select': 'auto',
                '-moz-user-select': 'auto',
                '-ms-user-select': 'auto'
            });
            lowerViewContainer.css({
                'user-select': 'auto',
                '-webkit-user-select': 'auto',
                '-moz-user-select': 'auto',
                '-ms-user-select': 'auto'
            });
            
            // Remove event listeners
            document.removeEventListener('mousemove', moveHandler);
            document.removeEventListener('touchmove', moveHandler, { passive: false });
            document.removeEventListener('mouseup', endHandler);
            document.removeEventListener('touchend', endHandler);
        };

        // Add event listeners
        document.addEventListener('mousemove', moveHandler);
        document.addEventListener('touchmove', moveHandler, { passive: false });
        document.addEventListener('mouseup', endHandler);
        document.addEventListener('touchend', endHandler);
    });

    return container;
};

const createTranslateButton = () => {
	return $('<button>✨번역하기</button>')
		.addClass('wikivault-button-primary')
		.prop('disabled', true)
		.addClass('wikivault-button-disabled');
};

const createSaveButton = () => {
	return $('<button>&#128190; 저장 · 게시</button>')
		.addClass('wikivault-button-primary')
		.prop('disabled', true)
		.addClass('wikivault-button-disabled');
};

const setupTranslationEventHandlers = () => {
	aiTranslateBtn.on('click', () => handleTranslateClick());
	backButton.on('click', () => handleBackClick());

	// Get references to the toggle and areas from the container data
	const viewToggle = wikiVaultTranslationContainer.data('viewToggle');
	const previewArea = wikiVaultTranslationContainer.data('previewArea');
	const sideBySideContainer = wikiVaultTranslationContainer.data('sideBySideContainer');
	const originalTextarea = wikiVaultTranslationContainer.data('originalTextarea');
	const translatedEditArea = wikiVaultTranslationContainer.find('#wikivault-translated-content'); // Get the main edit area


	viewToggle.on('change', function(isSelected) {
		// isSelected is true when the switch is on the right ("Compare with original")
		if (!isSelected) {
			// Show side-by-side, hide preview
			previewArea.hide();
			sideBySideContainer.show();

			// Update side-by-side content
			originalTextarea.val($('#wikivault-doc-modal-edit').val());

			// Show copy icons for side-by-side
			sideBySideContainer.find('.wikivault-copy-icon').show();
		} else {
			// Show preview, hide side-by-side
			sideBySideContainer.hide();
			previewArea.show();
			updateTranslatedPreview(); // Update preview when switching to preview mode

			// Hide copy icons in side-by-side view
			sideBySideContainer.find('.wikivault-copy-icon').hide();
		}
		// Always show the copy icon for the main editable translated content
		translatedEditArea.siblings('.wikivault-copy-icon').show();
	});

	// Trigger initial state based on default value
	viewToggle.emit('change', viewToggle.getValue());

	// Add input handler to the main translated textarea to update the readonly copy and preview
	translatedEditArea.on('input', function() {
		// Update the preview area if it's currently visible (switch is left)
		if (viewToggle.getValue()) {
			// Debounce the preview update
			clearTimeout(wikiVaultTranslationContainer.data('previewDebounceTimer'));
			const debounceTimer = setTimeout(() => {
				updateTranslatedPreview();
			}, 1000); // 1 second debounce
			wikiVaultTranslationContainer.data('previewDebounceTimer', debounceTimer);
		}
		// Adjust height after toggle changes
		adjustWikiEditorHeight();
	});
};

const showTranslationUI = () => {
    wikiVaultTranslationContainer.css('display', 'flex');

	// Get references from the container data
	const viewToggle = wikiVaultTranslationContainer.data('viewToggle');
	const previewArea = wikiVaultTranslationContainer.data('previewArea');
	const sideBySideContainer = wikiVaultTranslationContainer.data('sideBySideContainer');
	const originalTextarea = wikiVaultTranslationContainer.data('originalTextarea');
	const translatedEditArea = wikiVaultTranslationContainer.find('#wikivault-translated-content');
	const viewToggleContainer = wikiVaultTranslationContainer.data('viewToggleContainer');
	const translatedTextareaContainer = wikiVaultTranslationContainer.data('translatedTextareaContainer');
	const lowerViewContainer = wikiVaultTranslationContainer.data('lowerViewContainer');

	// Show the translation UI elements
	viewToggleContainer.show();
	translatedTextareaContainer.show();
	lowerViewContainer.show();

	// Ensure the main translated content textarea is visible
	translatedEditArea.show();

	// Default state: side-by-side view is active
	previewArea.hide();
	sideBySideContainer.show();

	// Update side-by-side content initially
	originalTextarea.val($('#wikivault-doc-modal-edit').val());

	// Show copy icons for side-by-side
	sideBySideContainer.find('.wikivault-copy-icon').show();

	// Always show the copy icon for the main editable translated content
	translatedEditArea.siblings('.wikivault-copy-icon').show();

    // Show back button and ensure it's visible
    backButton.css({
        'display': 'block',
        'opacity': '1',
        'visibility': 'visible'
    });

    // Update mode indicator
    wikiVaultDocModal.find('.ko-wiki-modal-mode').remove();
    const modeIndicator = createModeIndicator(true);
    wikiVaultDocModal.append(modeIndicator);

    // Update existence indicator position
    const existenceIndicator = wikiVaultDocModal.find('.ko-wiki-modal-indicator-container');
    if (existenceIndicator.length) {
        existenceIndicator.css('left', '45px');
    }
};

const hideTranslationUI = () => {
    wikiVaultTranslationContainer.css('display', 'none');

	// Hide individual translation UI elements as well
	const viewToggleContainer = wikiVaultTranslationContainer.data('viewToggleContainer');
	const translatedTextareaContainer = wikiVaultTranslationContainer.data('translatedTextareaContainer');
	const lowerViewContainer = wikiVaultTranslationContainer.data('lowerViewContainer');

	viewToggleContainer.hide();
	translatedTextareaContainer.hide();
	lowerViewContainer.hide();
};

const handleBackClick = () => {
	if (wikiVaultCancelButton.is(':visible')) {
		wikiVaultCancelButton.trigger('click');
		return;
	}

    hideTranslationUI(); // Call hideTranslationUI without arg
    showMainUI();

    // Reset translation-related states and UI
    translatedContent.val(''); // Clear textarea, but don't hide the textarea element itself, just its parent container
    $('#wikivault-translation-loading').hide();  // Hide loading animation
    $('#wikivault-translated-preview').empty().hide();  // Clear and hide preview if exists
    // $('#wikivault-compare-original-container').hide(); // This is removed, no need to hide
    $('#wikivault-original-content').val(''); // Clear the original textarea in the side-by-side view


	// Get references from the container data
	const viewToggle = wikiVaultTranslationContainer.data('viewToggle');
	const previewArea = wikiVaultTranslationContainer.data('previewArea');
	const sideBySideContainer = wikiVaultTranslationContainer.data('sideBySideContainer');
	const originalTextarea = wikiVaultTranslationContainer.data('originalTextarea');
	const translatedEditArea = wikiVaultTranslationContainer.find('#wikivault-translated-content');

	// Clear and hide content areas controlled by the toggle
	previewArea.hide();
	sideBySideContainer.hide();

	// Hide copy icons related to the side-by-side view
	sideBySideContainer.find('.wikivault-copy-icon').hide();

	// Hide copy icon for the main editable translated content as well when going back
	translatedEditArea.siblings('.wikivault-copy-icon').hide();

    // Reset buttons
    saveTranslationBtn.hide();
    aiTranslateBtn.show().prop('disabled', false).css('opacity', '1');

    // Hide back button
    backButton.css('display', 'none');

    // Reset existence indicator position
    const existenceIndicator = wikiVaultDocModal.find('.ko-wiki-modal-indicator-container');
    if (existenceIndicator.length) {
        existenceIndicator.css('left', '14px');
    }
};

const handleTranslateClick = () => {
	if (!wikiVaultAuth.hasSession()) {
		wikiVaultAuth.ensureLogin(handleTranslateClick);
		return;
	}
	const koIndicator = wikiVaultDocModal.find('.ko-wiki-indicator');
	const isKoExists = koIndicator.length > 0 && koIndicator.text().trim() === '한국어로 있음';
	const isFastGoogle = $('#wikivault-fast-google-checkbox').is(':checked');

	if (isFastGoogle) {
		// Supplement is not used in Fast Google mode
		startTranslationProcess({
			enabled: false,
			title: null
		});
	} else if (isKoExists) {
		// Outside Fast Google mode, keep the existing logic
		// Create a new window manager for the confirmation dialog
		const windowManager = new OO.ui.WindowManager();
		windowManager.$element.css({
			'position': 'fixed',
			'top': 0,
			'left': 0,
			'width': '100%',
			'height': '100%',
			'z-index': 2000,
			'background': 'rgba(0, 0, 0, 0.3)'
		});
		$('body').append(windowManager.$element);

		// Create a message dialog
		const messageDialog = new OO.ui.MessageDialog({
			size: 'medium'
		});
		windowManager.addWindows([messageDialog]);

		// Configure the dialog
		const config = {
			title: '확인',
			message: '한국어로 이미 문서가 존재합니다. 기존 한국어 문서를 보강하는 방식으로 처리하시겠습니까? (권장: "아니요"를 클릭)',
			actions: [
				{
					action: 'yes',
					label: '예',
					flags: 'safe'
				},
				{
					action: 'no',
					label: '아니요',
					flags: ['primary', 'progressive']
				}
			]
		};

		// Open the dialog and handle the result
		windowManager.openWindow(messageDialog, config).closed.then((data) => {
			windowManager.$element.remove();

			if (data && data.action === 'yes') {
				startTranslationProcess({
					enabled: true,
					title: koIndicator.attr('title')
				});
			} else {
				startTranslationProcess({
					enabled: false,
					title: null
				});
			}
		});
	} else {
		// Supplement is not used when there is no Korean version
		startTranslationProcess({
			enabled: false,
			title: null
		});
	}
};

const startTranslationProcess = (supplement) => {
	hideMainUI();
	showTranslationUI(); // Call showTranslationUI without tab container arg
	translatedContent.prop('readonly', true);

	// Show save button in disabled state
	saveTranslationBtn.show()
		.prop('disabled', true)
		.css('opacity', '0.5');

	// Show the cancel button
	wikiVaultCancelButton.show();

	// Adjust height immediately after showing the UI
	adjustWikiEditorHeight();

	// Check if fast-google-checkbox is checked
	const isFastGoogle = $('#wikivault-fast-google-checkbox').is(':checked');
	startTranslation(supplement, isFastGoogle);
};

const startTranslation = async (supplement = { enabled: false, title: null }, isFastGoogle = false) => {
	if (isFastGoogle) {
		// Fast Google Translate logic
		try {
			// 1. Get the current title
			const title = wikiVaultDocModalTitle.text();
			// 2. Fetch extract from enwiki
			const params = {
				action: 'query',
				prop: 'extracts',
				titles: title
			};
			const api = new mw.ForeignApi(CONSTANTS.API.WIKIPEDIA_EN);
			const data = await api.get(params);
			const page = data.query.pages[Object.keys(data.query.pages)[0]];
			let htmltext = page.extract || '';
			// 3. Convert HTML to wikitext-like format
			htmltext = htmltext
				.replaceAll(/<b>(.*?)<\/b>/mg, "'''$1'''")
				.replaceAll(/<h2[^>]*>(.*?)<\/h2>/mg, "<h2>== $1 ==<\/h2>")
				.replaceAll(/<h3[^>]*>(.*?)<\/h3>/mg, "<h3>=== $1 ===<\/h3>")
				.replaceAll(/<h4[^>]*>(.*?)<\/h4>/mg, "<h4>==== $1 ====<\/h4>")
				.replaceAll(/<h5[^>]*>(.*?)<\/h5>/mg, "<h5>===== $1 =====<\/h5>")
				.replaceAll(/<li>/mg, "<li>*&nbsp;")
				.replaceAll(/<p>/mg, "<p>\n");
			// 4. Call fast-translate endpoint
			const response = await fetch(CONSTANTS.API.MAIN_URI + CONSTANTS.API.FASTTRANSLATE_ENDPOINT, {
				method: 'POST',
				headers: wikiVaultAuth.headers({ 'Content-Type': 'application/json' }),
				body: JSON.stringify({
					username: wgUserName,
					prompt: htmltext
				})
			});
			if (response.status === 401) {
				wikiVaultAuth.handleUnauthorized();
				throw new Error('로그인이 필요합니다.');
			}
			const data2 = await response.json();
			const translatedText = data2.translatedText || '';
			// 5. Set translated content
			translatedContent.val(translatedText);
			// 6. Post-processing: categories, etc (same as normal)
			let translationComplete = true;
			let categoryProcessingComplete = false;
			let koreanCategories = [];
			const checkCompletion = () => {
				if (translationComplete && categoryProcessingComplete) {
					cleanupTranslation();
					if (!/^(틀|template):/i.test(title)) {
						appendReviewTemplate(title);
						appendKoreanCategories(koreanCategories);
					}
					translatedContent.prop('readonly', false);
					mw.notify('번역이 완료되었습니다.', { type: 'success' });
					saveTranslationBtn.prop('disabled', false).css('opacity', '1');
					const previewTab = $('.translation-tab-container').data('previewTab');
					if (previewTab) {
						previewTab.prop('disabled', false).css({ cursor: 'pointer', opacity: '1' });
					}
					// Hide cancel button when translation is complete
					wikiVaultCancelButton.hide();
				}
			};
			// Start category processing
			processCategoriesAsync($("#wikivault-doc-modal-edit").val()).then(categories => {
				koreanCategories = categories;
				categoryProcessingComplete = true;
				checkCompletion();
			}).catch(error => {
				console.error('Category processing failed:', error);
				categoryProcessingComplete = true;
				checkCompletion();
			});
		} catch (error) {
			translatedContent.val('[Error: 빠른 번역에 실패했습니다]');
			mw.notify('빠른 번역 중 오류가 발생했습니다: ' + error.message, { type: 'error' });
			translatedContent.prop('readonly', false);
			saveTranslationBtn.prop('disabled', false).css('opacity', '1');
		}
		return;
	}
	// ... existing code for normal translation ...
	const wikiText = $("#wikivault-doc-modal-edit").val();
	let payload = {
		prompt: wikiText,
		username: wgUserName,
		title: wikiVaultDocModalTitle.text(),
		thinking: $('#wikivault-setting-thinking-enabled').is(':checked'),
		thinking_amount: $('#wikivault-setting-thinking-slider').val(),
		temperature: $('#wikivault-setting-temperature-auto').is(':checked') ? "auto" : $('#wikivault-setting-temperature-slider').val(),
		supplement: supplement
	};

	if (/\S/.test($("#wikivault-korean-title-input").val())) {
		payload.korean_title = $("#wikivault-korean-title-input").val().trim();
	}

	if (/\S/.test($('#wikivault-translation-request-textarea').val())) {
		payload.translation_request = $('#wikivault-translation-request-textarea').val().trim();
	}

	let translationComplete = false;
	let categoryProcessingComplete = false;
	let koreanCategories = [];

	const checkCompletion = () => {
		if (translationComplete && categoryProcessingComplete) {
			cleanupTranslation();
			if (!/^(틀|template):/i.test(wikiVaultDocModalTitle.text())) {
				appendReviewTemplate(wikiVaultDocModalTitle.text());
				appendKoreanCategories(koreanCategories);
			}
			translatedContent.prop('readonly', false);
			mw.notify('번역이 완료되었습니다.', { type: 'success' });
			// Enable save button
			saveTranslationBtn.prop('disabled', false)
				.css('opacity', '1');
			// Enable preview tab
			const previewTab = $('.translation-tab-container').data('previewTab');
			if (previewTab) {
				previewTab.prop('disabled', false)
					.css({
						cursor: 'pointer',
						opacity: '1'
					});
			}
		}
	};

	// Start category processing
	processCategoriesAsync(wikiText).then(categories => {
		koreanCategories = categories;
		categoryProcessingComplete = true;
		checkCompletion();
	}).catch(error => {
		console.error('Category processing failed:', error);
		categoryProcessingComplete = true;
		checkCompletion();
	});

	const xhr = new XMLHttpRequest();
	window.currentTranslationXHR = xhr;
	xhr.open('POST', CONSTANTS.API.MAIN_URI + CONSTANTS.API.TRANSLATE_ENDPOINT, true);
	xhr.setRequestHeader('Content-Type', 'application/json');
	wikiVaultAuth.applyToXhr(xhr);

	setupTranslationProgress(xhr, () => {
		translationComplete = true;
		checkCompletion();
	});
	xhr.send(JSON.stringify(payload));
};

const setupTranslationProgress = (xhr, onComplete) => {
	translatedContent.val('');  // Clear textarea
	$('#wikivault-translation-loading').show();  // Show loading animation
	
	// Maintain buffer state in closure
	let buffer = {
		text: '',
		lastIndex: 0
	};

	xhr.onreadystatechange = () => {
		if (xhr.readyState === 3 || xhr.readyState === 4) {
			const newText = xhr.responseText.substring(buffer.lastIndex);
			buffer.lastIndex = xhr.responseText.length;
			buffer.text += newText;

			const regex = /"text"\s*:\s*"((?:\\.|[^"\\])*)"/g;
			let match;
			let consumedLength = 0;

			// Hide loading animation only when we start receiving actual content
			if (buffer.text.match(regex)) {
				$('#wikivault-translation-loading').hide();
			}

			while ((match = regex.exec(buffer.text)) !== null) {
				try {
					const raw = `"${match[1]}"`;
					const parsedText = JSON.parse(raw);
					translatedContent.val(translatedContent.val() + parsedText);
					translatedContent[0].scrollTop = translatedContent[0].scrollHeight;
					consumedLength = regex.lastIndex;
				} catch (e) {
					console.error('JSON parse error:', e, match[1]);
				}
			}

			if (consumedLength > 0) {
				buffer.text = buffer.text.slice(consumedLength);
			}
		}

		if (xhr.readyState === 4) {
			$('#wikivault-translation-loading').hide();
			// Hide the cancel button and clear XHR on completion or error
			wikiVaultCancelButton.hide();
			window.currentTranslationXHR = null;
			if (xhr.status !== 200) {
				translatedContent.val(translatedContent.val() + '\n[Error: 번역에 실패했습니다]\n');
				if (xhr.status === 401) {
					wikiVaultAuth.handleUnauthorized();
				} else if (xhr.status === 429) {
					mw.notify('번역에 실패했습니다: 한 사용자가 너무 많은 요청 수행', { type: 'error' });
				} else if (xhr.status === 500) {
					mw.notify('번역에 실패했습니다: 서버 오류', { type: 'error' });
				} else {
					mw.notify('번역에 실패했습니다', { type: 'error' });
				}
				// Enable save button
				saveTranslationBtn.prop('disabled', false)
					.css('opacity', '1');
					
				// Enable preview tab
				const previewTab = $('.translation-tab-container').data('previewTab');
				if (previewTab) {
					previewTab.prop('disabled', false)
						.css({
							cursor: 'pointer',
							opacity: '1'
						});
				}
			} else if (xhr.responseText.includes('event: end\ndata: [DONE]')) {
				onComplete();
			}
		}
	};

	xhr.onerror = () => {
		$('#wikivault-translation-loading').hide();
		translatedContent.val(translatedContent.val() + '\n[네트워크 오류]\n');
		// Hide the cancel button and clear XHR on network error
		wikiVaultCancelButton.hide();
		window.currentTranslationXHR = null;
	};
};

const processCategoriesAsync = async (wikiText) => {
	// Extract categories (ignoring anything after | in the category)
	const categoryRegex = /\[\[Category\s*:\s*([^|\]]+)/gi;
	const matches = [...wikiText.matchAll(categoryRegex)];
	const categories = matches.map(match => match[1].trim());

	if (categories.length === 0) return [];

	// Create titles parameter
	const titlesParam = categories.map(cat => `Category:${encodeURIComponent(cat)}`).join('|');

	// Fetch Korean translations
	try {
		const response = await fetch(
			CONSTANTS.API.WIKIPEDIA_EN + `?action=query&prop=langlinks&lllang=ko&format=json&origin=*&redirects=&titles=${titlesParam}`
		);
		const data = await response.json();

		// Process response
		const koreanCategories = [];
		if (data.query && data.query.pages) {
			Object.values(data.query.pages).forEach(page => {
				if (page.langlinks && page.langlinks.length > 0) {
					const koCategory = page.langlinks.find(link => link.lang === 'ko');
					if (koCategory) {
						koreanCategories.push(koCategory['*']);
					}
				}
			});
		}

		return koreanCategories;
	} catch (error) {
		console.error('Error fetching category translations:', error);
		return [];
	}
};

const appendReviewTemplate = (sourceTitle) => {
	const currentContent = translatedContent.val();
	const title = (sourceTitle || '').trim();
	const param = title ? `|번역된 원문=:en:${title}` : '';
	translatedContent.val(currentContent + `\n{{WikiVault 번역 검토 필요${param}}}\n`);
};

const appendKoreanCategories = (categories) => {
	if (!categories || categories.length === 0) return;

	const currentContent = translatedContent.val();

	// Keep only categories not already in currentContent
	const newCategories = categories.filter(cat => !currentContent.includes(`[[${cat}]]`));

	if (newCategories.length === 0) return;

	const categoryText = '\n' + newCategories.map(cat => `[[${cat}]]`).join('\n');
	translatedContent.val(currentContent + categoryText);
};

const cleanupTranslation = () => {
	let currentContent = translatedContent.val();
	let wordsToRemove = [ '</Content>', '</Content 1>', '</Content 2>', '</content>', '</content 1>', '</content 2>' ];
	function simplifyWikiLinks(str) {
		return str.replace(/\[\[([^\|\[\]]+)\|\1\]\]/ig, '[[$1]]');
	}
	for (let word of wordsToRemove) {
		currentContent = currentContent.split(word).join("");
	}
	currentContent = simplifyWikiLinks(currentContent);
	currentContent = currentContent.replace(/\{\{\s*웨이백 머신\s*\|/mg, '{{웹아카이브|').replace(/(및|그리고)\/또는/mg, '및').replace(/\{\{(DEFAULTSORT|기본정렬)\s*:\s*[^{}]*\}\}/img, '');
	currentContent = currentContent.replace(/(\|\s*)(archiveurl|archive-url)(\s*=\s*https:\/\/archive\.today\/[^\}\|]+)/img, '<!--$1$2$3-->');
	currentContent = currentContent.replace(/\{\{\s*([^|}]+?)\s+(출처|필요|문단)\|date=\s*([^\}|]+?)(?:\|\s*[^}]*)*\s*\}\}/img, '');
	currentContent = currentContent.replace(/\{\{\s*(출처|어조|문서 등재 기준|1차 자료)\|date=\s*([^\}|]+?)(?:\|\s*[^}]*)*\s*\}\}/img, '');
	translatedContent.val(currentContent);
};

const updateTranslatedPreview = () => {
	const previewArea = $('#wikivault-translated-preview');
	previewArea.empty();
	
	const loadingDots = $('<div class="loading-dots"><span></span><span></span><span></span></div>');
	previewArea.append(loadingDots);

	const api = new mw.ForeignApi(CONSTANTS.API.WIKIPEDIA_KO);
	const params = {
		format: 'json',
		action: 'parse',
		preview: true,
		disableeditsection: true,
		pst: true,
		title: wikiVaultDocModalTitle.text(),
		text: $('#wikivault-translated-content').val(),
		prop: 'text|categorieshtml|langlinks'
	};

	api.post(params)
		.then(data => {
			previewArea.empty();
			const htmlText = data.parse.text['*'] + (data.parse.categorieshtml ? data.parse.categorieshtml["*"] : '');
			previewArea.html(htmlText);
			
			previewArea.find('a, button, input, [role="button"]').css({
				'pointer-events': 'none',
				'cursor': 'default'
			}).on('click', function(e) {
				e.preventDefault();
				return false;
			});
		})
		.catch(error => {
			previewArea.empty();
			previewArea.html('<div style="color: red;">❌ 미리보기를 불러오는데 실패했습니다.</div>');
			console.error('Preview failed:', error);
		});
};

//#endregion


//#region 09. Save — Save dialog, page saving, talk page template

const setupSaveButtonHandler = () => {
	saveTranslationBtn.on('click', showSaveDialog);
};

const showSaveDialog = () => {
	// Store original overlay state
	const originalOverlayDisplay = wikiVaultOverlay.css('display');
	
	// Temporarily hide the original overlay while our dialog is open
	wikiVaultOverlay.hide();
	
	function SaveDialog(config) {
		SaveDialog.super.call(this, config);
	}
	OO.inheritClass(SaveDialog, OO.ui.ProcessDialog);
	
	// Static properties
	SaveDialog.static.name = 'saveDialog';
	SaveDialog.static.title = '문서 저장 · 게시';
	SaveDialog.static.size = 'medium';
	SaveDialog.static.actions = [
		{ action: 'save', label: '확인', flags: ['primary', 'progressive'] },
		{ action: 'cancel', label: '취소', flags: 'safe' }
	];

	// Setup dialog layout
	SaveDialog.prototype.initialize = function() {
		SaveDialog.super.prototype.initialize.call(this);
		
		// Add padding to the dialog body
		this.$body.css('padding', '20px'); // Add padding

		// Determine the source of content and initial title
		const isWritingTab = $('#글쓰기Content').is(':visible');
		let initialTitle = '';
		
		if (isWritingTab) {
			initialTitle = $('#wikivault-writing-title').val();
		} else {
			// For translation tab
			const indicator = wikiVaultDocModal.find('.ko-wiki-modal-indicator');
			const koreanTitle = indicator.length > 0 && indicator.attr('title');
			initialTitle = koreanTitle || wikiVaultDocModalTitle.text();
			if (/\S/.test($("#wikivault-korean-title-input").val())) {
				initialTitle = $("#wikivault-korean-title-input").val().trim();
			}
		}
		
		this.titleInput = new OO.ui.TextInputWidget({
			value: initialTitle,
			label: ''
		});

		this.radioSelect = new OO.ui.RadioSelectWidget({
			items: [
				new OO.ui.RadioOptionWidget({
					data: 'main',
					label: '일반 문서로 등재',
					id: 'wikivault-radio-main',
					disabled: true // Temporarily disabled
				}),
				new OO.ui.RadioOptionWidget({
					data: 'subpage',
					label: '사용자 문서의 하위 문서로 등재'
				}),
				new OO.ui.RadioOptionWidget({
					data: 'draft',
					label: '초안 문서로 등재'
				}),
				new OO.ui.RadioOptionWidget({
					data: 'file',
					label: '파일로 다운로드'
				})
			]
		});

		// Check if Korean version exists at initialization
		const indicator = wikiVaultDocModal.find('.ko-wiki-indicator');
		const hasKoreanVersion = indicator.length > 0 && indicator.text() === '한국어로 있음';

		// Create interwiki settings
		this.interwikiCheckbox = new OO.ui.CheckboxInputWidget({
			selected: !hasKoreanVersion, // Uncheck if Korean version exists
			id: 'wikivault-interwiki-checkbox'
		});

		this.interwikiTitleInput = new OO.ui.TextInputWidget({
			value: isWritingTab ? '' : ($('#wikivault-doc-modal-title').text() || ''),
			label: '',
			id: 'wikivault-original-title'
		});

		// Create interwiki settings layout
		const interwikiLayout = new OO.ui.FieldsetLayout({
			items: [
				new OO.ui.FieldLayout(this.interwikiCheckbox, {
					label: '인터위키 설정',
					align: 'inline'
				}),
				new OO.ui.FieldLayout(this.interwikiTitleInput, {
					label: '영어 원문 문서 제목',
					align: 'top'
				}),
				new OO.ui.FieldLayout(new OO.ui.LabelWidget({
					label: '인터위키 설정은 일반 문서 한정입니다. (한국어로 이미 있으면 이용 불가)',
					classes: ['wikivault-small-text']
				}))
			]
		});

		// Check if Korean version exists
		const koIndicator = wikiVaultDocModal.find('.ko-wiki-modal-indicator');
		const koreanTitle = koIndicator.length > 0 && koIndicator.attr('title');

		// Disable interwiki settings by default and if Korean version exists
		this.interwikiCheckbox.setDisabled(true);
		this.interwikiTitleInput.setDisabled(true);
		
		// Uncheck the checkbox if Korean version exists
		if (koreanTitle) {
			this.interwikiCheckbox.setSelected(false);
		}

		// Add radio select change handler to enable/disable interwiki settings
		this.radioSelect.on('select', (item) => {
			const isMainOption = item.getData() === 'main';
			const indicator = wikiVaultDocModal.find('.ko-wiki-indicator');
			const hasKoreanVersion = indicator.length > 0 && indicator.text() === '한국어로 있음';
			
			if (isMainOption) {
				if (hasKoreanVersion) {
					// Korean version exists: disable and uncheck the interwiki option
					this.interwikiCheckbox.setDisabled(true);
					this.interwikiTitleInput.setDisabled(true);
					this.interwikiCheckbox.setSelected(false);
				} else {
					// No Korean version: enable it
					this.interwikiCheckbox.setDisabled(false);
					this.interwikiTitleInput.setDisabled(false);
				}
			} else {
				// Always disabled for non-article pages
				this.interwikiCheckbox.setDisabled(true);
				this.interwikiTitleInput.setDisabled(true);
			}
		});
		this.radioSelect.selectItemByData('subpage');

		const layout = new OO.ui.FieldsetLayout({
			items: [
				new OO.ui.FieldLayout(this.titleInput, {
					label: $('<strong>').text('대상 제목'), // Make label bold
					align: 'top'
				}),
				new OO.ui.FieldLayout(this.radioSelect, {
					label: $('<strong>').text('위치'), // Make label bold
					align: 'top'
				}),
				new OO.ui.Widget({
					$element: $('<div>')
						.css({
							borderTop: '1px solid #ccc',
							margin: '1em 0'
						})
				}),
				interwikiLayout
			]
		});

		this.$body.append(layout.$element);

		// Initially disable save button if title is empty
		this.actions.setAbilities({ save: !!initialTitle.trim() });

		// Add input handler to update save button state
		this.titleInput.on('change', () => {
			this.actions.setAbilities({ save: !!this.titleInput.getValue().trim() });
		});
	};

	// Handle dialog actions
	SaveDialog.prototype.getActionProcess = function(action) {
		const dialog = this;

		if (action === 'save') {
			// Wrap the logic in a setTimeout to ensure widget state is updated
			return new OO.ui.Process(() => {
				return new Promise((resolve) => {
					// Add a small delay
					setTimeout(() => {
						// Capture interwiki settings AFTER the delay
						const isInterwikiSelected = dialog.interwikiCheckbox.isSelected();
						const originalEnglishTitle = dialog.interwikiTitleInput.getValue();

						// Determine the source of content for file download
						const isWritingTab = $('#글쓰기Content').is(':visible');

						// Determine formatted title based on selected option
						const selectedOption = dialog.radioSelect.findSelectedItem().getData();
						const title = dialog.titleInput.getValue().trim();

						let formattedTitle;
						switch (selectedOption) {
							case 'subpage':
								if (/^(사용자|User):/i.test(title)) {
									mw.notify('제목에 "사용자:"를 사용할 수 없습니다.', { type: 'error' });
									resolve();
									return;
								}
								formattedTitle = 'User:' + wgUserName + '/WikiVault/' + title;
								break;
							case 'draft':
								if (/^(초안|Draft):/i.test(title)) {
									title = title.replace(/^(초안|Draft):/i, '');
								}
								formattedTitle = 'Draft:' + title;
								break;
							case 'main':
								if (/^(초안|Draft):/i.test(title)) {
									mw.notify('초안 문서를 일반 문서로 취급할 수 없습니다.', { type: 'error' });
									resolve();
									return;
								}
								if (/^(사용자|User):/i.test(title)) {
									mw.notify('사용자 문서를 일반 문서로 취급할 수 없습니다.', { type: 'error' });
									resolve();
									return;
								}
								formattedTitle = title;
								break;
						}

						if (selectedOption === 'file') {
							let content;
							if ($('#wikivault-writing-content').is(':visible')) {
								content = $('#wikivault-writing-content').val();
							} else {
								content = $('#wikivault-translated-content').val();
							}

							if (!content) {
								mw.notify('저장할 내용이 없습니다.', { type: 'error' });
								resolve();
								return;
							}

							const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
							const url = window.URL.createObjectURL(blob);
							const a = document.createElement('a');
							a.style.display = 'none';
							a.href = url;
							a.download = `${title}.txt`;

							document.body.appendChild(a);
							a.click();

							setTimeout(() => {
								document.body.removeChild(a);
								window.URL.revokeObjectURL(url);
							}, 100);

							dialog.close().closed.then(() => {
								restoreModalState();
								resolve(); // Resolve after closing dialog and restoring state
							});

							return; // Exit the timeout callback
						}

						// Now proceed with the original wiki page save process
						dialog.close().closed.then(() => {
							restoreModalState();

							return new Promise((resolveSave, rejectSave) => {
								const api = new mw.ForeignApi(CONSTANTS.API.WIKIPEDIA_KO);
								api.get({
									action: 'query',
									titles: formattedTitle,
									format: 'json'
								}).done((response) => {
									const pages = response.query.pages;
									const pageExists = !Object.keys(pages).includes('-1');

									if (pageExists) {
										// Create a new window manager for the confirmation dialog
										const windowManager = new OO.ui.WindowManager();
										windowManager.$element.css({
											'position': 'fixed',
											'top': 0,
											'left': 0,
											'width': '100%',
											'height': '100%',
											'z-index': 2000, // Same as the save dialog's z-index
											'background': 'rgba(0, 0, 0, 0.3)'
										});
										$('body').append(windowManager.$element);

										// Create a message dialog
										const messageDialog = new OO.ui.MessageDialog({
											size: 'medium',
											classes: ['wikivault-message-dialog']
										});
										windowManager.addWindows([messageDialog]);

										// Configure the dialog
										const config = {
											title: '확인',
											message: '문서가 이미 있습니다. 덮어쓰시겠습니까?',
											actions: [
												{
													action: 'accept',
													label: '확인',
													flags: ['primary', 'progressive']
												},
												{
													action: 'cancel',
													label: '취소',
													flags: 'safe'
												}
											]
										};

										// Open the dialog and handle the result
										windowManager.openWindow(messageDialog, config).closed.then((data) => {
											if (data && data.action === 'accept') {
												saveWikiPage(formattedTitle, selectedOption, isInterwikiSelected, originalEnglishTitle);
											}
											windowManager.$element.remove();
											resolveSave(); // Resolve the save promise after handling overwrite
										});
									} else {
										saveWikiPage(formattedTitle, selectedOption, isInterwikiSelected, originalEnglishTitle);
										resolveSave(); // Resolve the save promise after saving new page
									}
								}).fail((error) => {
									console.error('Error checking page:', error);
									mw.notify('문서 확인 중 오류가 발생했습니다.', { type: 'error' });
									rejectSave(error); // Reject the save promise on error
								});
							});
						}).then(resolve); // Resolve the outer promise after the save process
					}, 0); // 0ms delay
				});
			});
		} else if (action === 'cancel') {
			return new OO.ui.Process(() => {
				return dialog.close().closed.then(() => {
						restoreModalState();
					});
			});
		}
		return SaveDialog.super.prototype.getActionProcess.call(this, action);
	};

	// Create and setup window manager with higher z-index
	const windowManager = new OO.ui.WindowManager();
	const $windowManagerElement = windowManager.$element;
	
	// Apply styles to ensure dialog appears above other modals
	$windowManagerElement.css({
		'position': 'fixed',
		'top': 0,
		'left': 0,
		'width': '100%',
		'height': '100%',
		'z-index': 2000,
		'background': 'rgba(0, 0, 0, 0.3)'
	});
	
	// Append to body instead of the modal
	$('body').append($windowManagerElement);
	
	const dialog = new SaveDialog();
	windowManager.addWindows([dialog]);

	// Function to restore modal state
	const restoreModalState = () => {
		// First restore the overlay
		wikiVaultOverlay.css('display', originalOverlayDisplay);
		
		// Then restore modal window state
		wikiVaultModalWindow.css({
			opacity: '1',
			pointerEvents: 'auto'
		});
		
		// Finally cleanup the window manager
		setTimeout(() => {
			windowManager.clearWindows().then(() => {
				windowManager.destroy();
				$windowManagerElement.remove();
			});
		}, 250);
	};

	// Open the dialog
	windowManager.openWindow(dialog);

	// Handle unexpected closing
	dialog.on('closing', () => {
		restoreModalState();
	});
};

const saveWikiPage = (formattedTitle, selectedOption, isInterwikiSelected, originalEnglishTitle) => {
	const api = new mw.ForeignApi(CONSTANTS.API.WIKIPEDIA_KO);

	// Check whether the writing tab is currently active
	let text;
	const isWritingMode = $('#wikivault-writing-content').is(':visible');
	if (isWritingMode) {
		text = $('#wikivault-writing-content').val();
	} else {
		text = $('#wikivault-translated-content').val();
	}

	const getSummaryExtra = () => {
		if (isWritingMode) {
			return Promise.resolve('');
		}
		const enApi = new mw.ForeignApi(CONSTANTS.API.WIKIPEDIA_EN);
		return enApi.get({
			action: 'query',
			prop: 'revisions',
			titles: originalEnglishTitle,
			rvprop: 'ids',
			rvlimit: 1
		}).then((data) => {
			const page = Object.values(data.query.pages)[0];
			const revId = page.revisions[0].revid;
			return ' - 번역된 원문: [[:en:Special:PermanentLink/' + revId + '|' + originalEnglishTitle + ']]';
		});
	};

	// Helper function to handle CAPTCHA challenges
	const handleCaptchaChallenge = (editParams, captchaId) => {
		const captchaUrl = 'https://ko.wikipedia.org/w/index.php?title=Special:Captcha/image&wpCaptchaId=' + captchaId;
		
		// Create custom CAPTCHA modal
		const captchaModal = $('<div>').addClass('captcha-modal').css({
			'position': 'fixed',
			'top': '0',
			'left': '0',
			'width': '100%',
			'height': '100%',
			'background-color': 'rgba(0, 0, 0, 0.8)',
			'z-index': '9999999',
			'display': 'flex',
			'align-items': 'center',
			'justify-content': 'center'
		});
		
		const captchaContent = $('<div>').addClass('captcha-content').css({
			'background': 'white',
			'padding': '30px',
			'border-radius': '8px',
			'box-shadow': '0 4px 20px rgba(0, 0, 0, 0.3)',
			'text-align': 'center',
			'max-width': '400px',
			'width': '90%'
		});
		
		const captchaTitle = $('<h3>').text('CAPTCHA 확인').css({
			'margin-bottom': '20px',
			'color': '#333'
		});
		
		const captchaImage = $('<img>').attr('src', captchaUrl).css({
			'height': '72px',
			'margin-bottom': '15px',
			'border': '1px solid #ddd',
			'border-radius': '4px'
		});
		
		const captchaInput = $('<input>').attr({
			'type': 'text',
			'placeholder': 'CAPTCHA를 입력하세요'
		}).css({
			'width': '100%',
			'padding': '10px',
			'border': '1px solid #ddd',
			'border-radius': '4px',
			'margin-bottom': '15px',
			'font-size': '16px'
		});
		
		const buttonContainer = $('<div>').css({
			'display': 'flex',
			'gap': '10px',
			'justify-content': 'center'
		});
		
		const submitButton = $('<button>').text('확인').css({
			'padding': '10px 20px',
			'background-color': '#36c',
			'color': 'white',
			'border': 'none',
			'border-radius': '4px',
			'cursor': 'pointer',
			'font-size': '14px'
		});
		
		const cancelButton = $('<button>').text('취소').css({
			'padding': '10px 20px',
			'background-color': '#666',
			'color': 'white',
			'border': 'none',
			'border-radius': '4px',
			'cursor': 'pointer',
			'font-size': '14px'
		});
		
		// Assemble the modal
		buttonContainer.append(submitButton, cancelButton);
		captchaContent.append(captchaTitle, captchaImage, captchaInput, buttonContainer);
		captchaModal.append(captchaContent);
		
		// Add to body
		$('body').append(captchaModal);
		
		// Focus on input
		captchaInput.focus();
		
		// Handle submit
		const handleSubmit = () => {
			const result = captchaInput.val().trim();
			if (result) {
				captchaModal.remove();
				
				// Add CAPTCHA parameters to the request
				editParams.captchaid = captchaId;
				editParams.captchaword = result;
				
				// Retry the edit with CAPTCHA
				api.postWithEditToken(editParams).then(function(response) {
					if (response.edit && response.edit.result === 'Success') {
						mw.notify('문서가 성공적으로 게시되었습니다.', { type: 'success' });
						
						// Show link notification modal
						showLinkNotificationModal(formattedTitle, selectedOption, isInterwikiSelected);

						// Load settings to check attachTranslationTemplate
						handleTalkPageCreation(formattedTitle, originalEnglishTitle, selectedOption, api);
						
						// Handle interwiki if needed
						if (selectedOption === 'main' && isInterwikiSelected) {
							setTimeout(() => {
								const wikidataAPI = new mw.ForeignApi('https://www.wikidata.org/w/api.php');
								const json = {
									action: 'wbsetsitelink',
									site: 'enwiki',
									title: originalEnglishTitle,
									linksite: 'kowiki',
									linktitle: formattedTitle
								};

								wikidataAPI.postWithToken('csrf', json, {
									success: function(response) {
										if (response.error && response.error.info) {
											mw.notify('인터위키 설정에 실패했습니다: ' + response.error.info, { type: 'error' });
										} else {
											mw.notify('인터위키가 성공적으로 설정되었습니다.', { type: 'success' });
										}
									},
									error: function(error) {
										console.error('Error setting interwiki link:', error);
										mw.notify('인터위키 설정 중 오류가 발생했습니다. ' + error, { type: 'error' });
									}
								});
							}, 2000);
						}
					} else if (response.edit && response.edit.result === 'Failure') {
						// Check if there's another CAPTCHA challenge
						if (response.edit.captcha && response.edit.captcha.id) {
							handleCaptchaChallenge(editParams, response.edit.captcha.id);
						} else {
							mw.notify('문서 게시에 실패했습니다.', { type: 'error' });
						}
					} else {
						mw.notify('문서 게시에 실패했습니다.', { type: 'error' });
					}
				}).catch((error) => {
					console.error('Error publishing page with CAPTCHA:', error);
					mw.notify('문서 게시 중 오류가 발생했습니다. ' + error, { type: 'error' });
				});
			} else {
				mw.notify('CAPTCHA를 입력해주세요.', { type: 'error' });
			}
		};
		
		// Handle cancel
		const handleCancel = () => {
			captchaModal.remove();
			mw.notify('CAPTCHA 입력이 취소되었습니다.', { type: 'warning' });
		};
		
		// Event handlers
		submitButton.on('click', handleSubmit);
		cancelButton.on('click', handleCancel);
		captchaInput.on('keypress', function(e) {
			if (e.which === 13) { // Enter key
				handleSubmit();
			}
		});
		
		// Close on background click
		captchaModal.on('click', function(e) {
			if (e.target === captchaModal[0]) {
				handleCancel();
			}
		});
	};

	// Function to show link notification modal
	const showLinkNotificationModal = (formattedTitle, selectedOption, isInterwikiSelected) => {
		// Create modal using same CSS as handleCaptchaChallenge
		const linkModal = $('<div>').addClass('link-notification-modal').css({
			'position': 'fixed',
			'top': '0',
			'left': '0',
			'width': '100%',
			'height': '100%',
			'background-color': 'rgba(0, 0, 0, 0.8)',
			'z-index': '9999999',
			'display': 'flex',
			'align-items': 'center',
			'justify-content': 'center'
		});
		
		const linkContent = $('<div>').addClass('link-notification-content').css({
			'background': 'white',
			'padding': '30px',
			'border-radius': '8px',
			'box-shadow': '0 4px 20px rgba(0, 0, 0, 0.3)',
			'text-align': 'center',
			'max-width': '500px',
			'width': '90%'
		});
		
		const linkTitle = $('<h3>').text('문서 게시 완료').css({
			'margin-bottom': '20px',
			'color': '#333'
		});
		
		const linkText = $('<p>').text('문서가 성공적으로 게시되었습니다.').css({
			'margin-bottom': '15px',
			'color': '#555',
			'font-size': '16px'
		});
		
		const linkUrl = `https://ko.wikipedia.org/wiki/${encodeURIComponent(formattedTitle)}`;
		const linkElement = $('<a>').attr('href', linkUrl).attr('target', '_blank').text(formattedTitle).css({
			'color': '#36c',
			'text-decoration': 'none',
			'font-weight': 'bold',
			'font-size': '18px',
			'display': 'block',
			'margin-bottom': '15px',
			'word-break': 'break-all'
		});
		
		const interwikiNote = $('<div>')
			.addClass('interwiki-progress-container')
			.css({
				'margin-bottom': '20px',
				'padding': '10px',
				'border-radius': '4px',
				'background': '#f5f5f5'
			});

		const progressBar = $('<div>')
			.addClass('interwiki-progress-bar')
			.css({
				'width': '0%',
				'height': '4px',
				'background': '#3498db',
				'border-radius': '2px',
				'transition': 'width 0.3s ease-in-out',
				'margin-top': '8px'
			});

		const statusText = $('<div>')
			.text('인터위키를 적용하는 중...')
			.css({
				'color': '#666',
				'margin-bottom': '4px',
				'font-size': '14px'
			});

		const statusIcon = $('<span>')
			.addClass('interwiki-status-icon')
			.css({
				'display': 'inline-block',
				'margin-left': '8px',
				'width': '16px',
				'height': '16px',
				'border-radius': '50%',
				'text-align': 'center',
				'line-height': '16px',
				'font-size': '12px',
				'display': 'none'
			});

		interwikiNote
			.append(statusText)
			.append(progressBar)
			.append(statusIcon);
		
		const buttonContainer = $('<div>').css({
			'display': 'flex',
			'gap': '10px',
			'justify-content': 'center'
		});
		
		const openButton = $('<button>').text('문서 열기').css({
			'padding': '10px 20px',
			'background-color': '#36c',
			'color': 'white',
			'border': 'none',
			'border-radius': '4px',
			'cursor': 'pointer',
			'font-size': '14px'
		});
		
		const closeButton = $('<button>').text('닫기').css({
			'padding': '10px 20px',
			'background-color': '#666',
			'color': 'white',
			'border': 'none',
			'border-radius': '4px',
			'cursor': 'pointer',
			'font-size': '14px'
		});
		
		// Assemble the modal
		buttonContainer.append(openButton, closeButton);
		linkContent.append(linkTitle, linkText, linkElement);
		
		// Add interwiki note only if condition is met
		if (selectedOption === 'main' && isInterwikiSelected) {
			linkContent.append(interwikiNote);
		}
		
		linkContent.append(buttonContainer);
		linkModal.append(linkContent);
		
		// Add to body
		$('body').append(linkModal);
		
		// Event handlers
		openButton.on('click', () => {
			window.open(linkUrl, '_blank');
		});
		
		closeButton.on('click', () => {
			linkModal.remove();
		});
		
		// Close on background click
		linkModal.on('click', function(e) {
			if (e.target === linkModal[0]) {
				linkModal.remove();
			}
		});
	};

	getSummaryExtra().then((summary_extra) => {
		const params = {
			action: 'edit',
			format: 'json',
			summary: 'WikiVault의 도움을 받아 게시' + summary_extra,
			text: text,
			title: formattedTitle,
			tags: 'wikivault'
		};

		return api.postWithEditToken(params).then(function(response) {
			if (response.edit && response.edit.result === 'Success') {
				mw.notify('문서가 성공적으로 게시되었습니다.', { type: 'success' });

				// Show link notification modal
				showLinkNotificationModal(formattedTitle, selectedOption, isInterwikiSelected);

				// Load settings to check attachTranslationTemplate
				handleTalkPageCreation(formattedTitle, originalEnglishTitle, selectedOption, api);

				// Handle interwiki if needed
				if (selectedOption === 'main' && isInterwikiSelected) {
					setTimeout(() => {
						// Update progress to 50% when starting
						$('.interwiki-progress-bar').css('width', '50%');
						
						const wikidataAPI = new mw.ForeignApi('https://www.wikidata.org/w/api.php');
						const json = {
							action: 'wbsetsitelink',
							site: 'enwiki',
							// Use the passed original English title
							title: originalEnglishTitle,
							linksite: 'kowiki',
							linktitle: formattedTitle
						};

						wikidataAPI.postWithToken('csrf', json, {
							success: function(response) {
								if (response.error && response.error.info) {
									// Update to failure state
									$('.interwiki-progress-bar').css({
										'width': '100%',
										'background': '#e74c3c'
									});
									$('.interwiki-status-icon')
										.css({
											'background': '#e74c3c',
											'color': 'white',
											'display': 'inline-block'
										})
										.text('!');
									$('.interwiki-progress-container .status-text').text('인터위키 설정 실패');
									mw.notify('인터위키 설정에 실패했습니다: ' + response.error.info, { type: 'error' });
								} else {
									// Update to success state
									$('.interwiki-progress-bar').css({
										'width': '100%',
										'background': '#2ecc71'
									});
									$('.interwiki-status-icon')
										.css({
											'background': '#2ecc71',
											'color': 'white',
											'display': 'inline-block'
										})
										.text('✓');
									$('.interwiki-progress-container .status-text').text('인터위키 설정 완료');
									mw.notify('인터위키가 성공적으로 설정되었습니다.', { type: 'success' });
								}
						},
						error: function(error) {
							// Update to failure state
							$('.interwiki-progress-bar').css({
								'width': '100%',
								'background': '#e74c3c'
							});
							$('.interwiki-status-icon')
								.css({
									'background': '#e74c3c',
									'color': 'white',
									'display': 'inline-block'
								})
								.text('!');
							$('.interwiki-progress-container .status-text').text('인터위키 설정 실패');
							console.error('Error setting interwiki link:', error);
							mw.notify('인터위키 설정 중 오류가 발생했습니다. ' + error, { type: 'error' });
						}
					});
					}, 2000); // Reintroduce 2-second delay
				}
			} else if (response.edit && response.edit.result === 'Failure') {
				// Check if CAPTCHA is required
				if (response.edit.captcha && response.edit.captcha.id) {
					handleCaptchaChallenge(params, response.edit.captcha.id);
				} else {
					mw.notify('문서 게시에 실패했습니다.', { type: 'error' });
				}
			} else {
				mw.notify('문서 게시에 실패했습니다.', { type: 'error' });
			}
		});
	}).catch((error) => {
		console.error('Error publishing page:', error);
		mw.notify('문서 게시 중 오류가 발생했습니다. ' + error, { type: 'error' });
	});
};

// Attach or update the translation template on the talk page
const handleTalkPageCreation = async (formattedTitle, originalEnglishTitle, selectedOption, api) => {
	// Load settings to check attachTranslationTemplate
	const settings = JSON.parse(localStorage.getItem('wikivaultSettings')) || {};

	if (selectedOption === 'main' && settings.attachTranslationTemplate) {
		const talkPageTitle = '토론:' + formattedTitle;
		const translationTemplate = '{{번역된 문서|en|' + originalEnglishTitle + '}}';

		try {
			// Check if talk page exists
			const response = await api.get({
				action: 'query',
				prop: 'revisions',
				rvprop: 'content',
				titles: talkPageTitle,
				format: 'json',
				rvslots: 'main'
			});

			const pages = response.query.pages;
			const pageId = Object.keys(pages)[0];
			const page = pages[pageId];

			if (page.missing === undefined) { // Page exists
				const currentContent = page.revisions[0].slots.main['*'];
				if (!currentContent.includes('{{번역된 문서|')) {
					// Prepend if template does not exist
					const prependParams = {
						action: 'edit',
						format: 'json',
						summary: 'WikiVault의 도움을 받아 번역된 문서 틀 부착',
						text: translationTemplate + '\n' + currentContent, // Prepend new template
						title: talkPageTitle
					};
					const prependResponse = await api.postWithEditToken(prependParams);
					if (prependResponse.edit && prependResponse.edit.result === 'Success') {
						mw.notify('기존 토론 문서에 번역된 문서 틀이 성공적으로 추가되었습니다.', { type: 'success' });
					} else {
						mw.notify('기존 토론 문서에 번역된 문서 틀 추가에 실패했습니다.', { type: 'error' });
						console.error('Error prepending translation template to existing talk page:', prependResponse);
					}
				} else {
					mw.notify('토론 문서에 이미 번역된 문서 틀이 있습니다.', { type: 'info' });
				}
			} else { // Page does not exist
				const createParams = {
					action: 'edit',
					format: 'json',
					summary: 'WikiVault의 도움을 받아 번역된 문서 틀 부착',
					text: translationTemplate,
					title: talkPageTitle
				};
				const createResponse = await api.postWithEditToken(createParams);
				if (createResponse.edit && createResponse.edit.result === 'Success') {
					mw.notify('새 토론 문서에 번역된 문서 틀이 성공적으로 부착되었습니다.', { type: 'success' });
				} else {
					mw.notify('새 토론 문서에 번역된 문서 틀 부착에 실패했습니다.', { type: 'error' });
					console.error('Error attaching translation template to new talk page:', createResponse);
				}
			}
		} catch (error) {
			mw.notify('토론 문서 존재 확인 또는 편집 중 오류가 발생했습니다: ' + error, { type: 'error' });
			console.error('Error checking or editing talk page:', error);
		}
	}
};

//#endregion


//#region 10. Writing — Writing tab

const setupWritingTab = (tabContent) => {
  const titleContainer = $('<div class="wikivault-writing-title-container"></div>').css({
    marginBottom: '20px',
    width: '100%'
  });

  titleContainer.append('<label for="wikivault-writing-title" style="display: block; margin-bottom: 5px; font-weight: bold;">제목</label>');
  const titleInput = $('<input type="text" id="wikivault-writing-title" autocomplete="off" class="title-input" placeholder="제목을 입력하세요 (예: 사과)">').css({
    width: '100%',
    padding: '8px',
    border: '1px solid #ddd',
    borderRadius: '4px'
  });

  titleContainer.append(titleInput);

  // Create container for writing form
  const writingContainer = $('<div class="wikivault-writing-container"></div>').css({
    'padding': '20px'
  });

  writingContainer.append(titleContainer);

  // Add context textarea
  const contextContainer = $('<div class="wikivault-writing-context-container"></div>').css({
    'margin-bottom': '20px',
    'width': '100%' // Ensure container takes full width
  });
    
  contextContainer.append('<label for="wikivault-writing-context" style="display: block; margin-bottom: 5px; font-weight: bold;">주제 설명</label>');
  const contextTextarea = $('<textarea id="wikivault-writing-context" placeholder="문서의 주제에 대해 설명해주세요 (예: 사과는 과일이다.)" rows="5"></textarea>').css({
    'width': '100%',
    'padding': '8px',
    'border': '1px solid #ddd',
    'border-radius': '4px',
    'resize': 'none'
  });

	// Create container for context area and copy icon
	const contextAreaContainer = $('<div></div>').addClass('wikivault-textarea-container').css({
		'width': '100%',
		'height': 'auto' // Auto height for this one as rows is set
	});

	// Add copy icon
	const contextCopyIcon = createCopyIcon();

	// Append textarea and icon to container
	contextAreaContainer.append(contextTextarea, contextCopyIcon);

	// Add click handler to copy icon
	contextCopyIcon.on('click', () => copyTextToClipboard(contextTextarea.val()));

	// Append container to contextContainer
	contextContainer.append(contextAreaContainer);

  writingContainer.append(contextContainer);

  // Create a button container for layout
  const buttonContainer = $('<div></div>').css({
    'margin-top': '10px',
    'display': 'flex', // Use flexbox to align buttons
    'justify-content': 'flex-end', // Align buttons to the right
    'gap': '10px' // Add space between buttons
  });

  // Add write button
  const writeButton = $('<button id="wikivault-start-writing">글쓰기 시작</button>')
    .addClass('wikivault-button-primary');

  // Add preview button (initially disabled and visible)
  const previewButton = $('<button id="wikivault-preview-writing">미리 보기</button>')
    .addClass('wikivault-button-primary wikivault-button-disabled') // Initially disabled class for styling
    .prop('disabled', true); // Initially disabled

  // Add save button (initially disabled and visible)
  const saveButton = $('<button id="wikivault-save-writing">&#128190; 저장 · 게시</button>')
    .addClass('wikivault-button-primary wikivault-button-disabled') // Add disabled class for styling
    .prop('disabled', true); // Initially disabled

  // Append buttons to the button container
  buttonContainer.append(writeButton, previewButton, saveButton);

  // Append the button container to the main writing container
  writingContainer.append(buttonContainer);

  // Create content textarea and its container (initially hidden)
  const contentArea = $('<textarea class="wikivault-writing-content" id="wikivault-writing-content"></textarea>').css({
    'width': '100%',
    'height': '250px',
    'padding': '10px',
    'border': '1px solid #ddd',
    'border-radius': '4px',
    'resize': 'none'
  });

  const contentAreaContainer = $('<div></div>').addClass('wikivault-textarea-container').css({
    'width': '100%', // Match textarea width
    'height': '300px', // Match textarea height
    'margin-top': '20px', // Match textarea margin
  }).hide(); // Initially hidden

	// Add copy icon to content area container
	const writingCopyIcon = createCopyIcon();
	contentAreaContainer.append(contentArea, writingCopyIcon);
	writingCopyIcon.on('click', () => copyTextToClipboard(contentArea.val()));
	mw.loader.using( [
		'ext.wikiEditor'
	] ).then( ( require ) => {
		mw.addWikiEditor( $( '#wikivault-writing-content' ) );
	} );

  // Create preview area (initially hidden)
  const previewArea = $('<div class="wikivault-writing-preview"></div>').css({
    'width': '100%',
    'height': '300px',
    'padding': '10px',
    'margin-top': '20px',
    'border': '1px solid #ddd',
    'border-radius': '4px',
    'overflow-y': 'auto',
		'user-select': 'text',
		'pointer-events': 'auto',
		'cursor': 'default'
  }).hide(); // Initially hidden


  // Add content area container and preview area to the main writing container
  writingContainer.append(contentAreaContainer, previewArea);


  // Add result container (initially hidden, used for loading and sources)
  const resultContainer = $('<div id="wikivault-writing-result" style="display: none;"></div>');
  writingContainer.append(resultContainer);

  // Add warning messages
  writingContainer.append("<p style='font-size: 80%; margin-top: 20px;'><span class='warning-icon'>&#9889;</span>출처 및 생성된 결과물은 사용자의 확인이 필요합니다.</p>");
  writingContainer.append("<p style='font-size: 80%;'><span class='warning-icon'>&#9889;</span>자료의 가용성이 낮을 경우, 결과 출력이 지연되거나 오류가 발생할 수 있습니다.</p>");
  writingContainer.append("<p style='font-size: 80%;'><span class='warning-icon'>&#9889;</span>원하는 출처에 대해 + 버튼을 클릭하여 가져오세요.</p>");


  // Append everything to tab content
  tabContent.append(writingContainer);

  // Setup event handlers (passing the created buttons and containers)
  setupWritingHandlers(writeButton, previewButton, saveButton, titleInput, contextTextarea, resultContainer, contentAreaContainer, contentArea, previewArea);
};

const setupWritingHandlers = (writeButton, previewButton, saveButton, titleInput, contextTextarea, resultContainer, contentAreaContainer, contentArea, previewArea) => {

    let isPreviewMode = false; // Keep track of preview mode state

    previewButton.on('click', () => {
        if (!isPreviewMode) {
            // Switch to preview mode
            previewButton.text('편집으로 돌아가기');
            contentAreaContainer.hide(); // Hide the container with textarea and icon
            previewArea.show();
            updateWritingPreview(contentArea.val(), previewArea);
        } else {
            // Switch back to edit mode
            previewButton.text('미리 보기');
            previewArea.hide();
            contentAreaContainer.show(); // Show the container
        }
        isPreviewMode = !isPreviewMode;
    });

    saveButton.on('click', () => {
        showSaveDialog(); // Call the save dialog function
    });

    writeButton.on('click', () => {
        const title = titleInput.val().trim();
        const context = contextTextarea.val().trim();

        if (!title || !context) {
            mw.notify('제목과 주제 설명을 모두 입력해주세요.', { type: 'error' });
            return;
        }

		if (context.length < 5) {
			mw.notify('주제 설명은 최소 5자 이상이어야 합니다.', { type: 'error' });
			return;
		}

        if (!wikiVaultAuth.hasSession()) {
            wikiVaultAuth.ensureLogin(() => writeButton.trigger('click'));
            return;
        }

        // Disable inputs and button while processing
        titleInput.prop('disabled', true);
        contextTextarea.prop('disabled', true);
        writeButton.prop('disabled', true).addClass('wikivault-button-disabled');
		// Also disable the save and preview buttons during writing
		saveButton.prop('disabled', true).addClass('wikivault-button-disabled');
        previewButton.prop('disabled', true).addClass('wikivault-button-disabled');

        // Show result container for loading animation, clear previous content areas
        resultContainer.html('<div class="loading-dots"><span></span><span></span><span></span></div>').show();
		contentArea.val(''); // Clear the content area
        contentAreaContainer.hide(); // Hide content area during loading
        previewArea.hide(); // Ensure preview area is hidden during loading

		wikiVaultCancelButton.show();

        // Prepare payload
        const payload = {
            username: wgUserName,
            title: title,
            context: context,
            thinking: $('#wikivault-setting-thinking-enabled').is(':checked'),
            thinking_amount: $('#wikivault-setting-thinking-slider').val(), // Add thinking_amount from the slider
            temperature: "0.0" //$('#wikivault-setting-temperature-auto').is(':checked') ? "auto" : $('#wikivault-setting-temperature-slider').val()
        };

        // Create and setup XHR
        const xhr = new XMLHttpRequest();
        window.currentWritingXHR = xhr;
        xhr.open('POST', `${CONSTANTS.API.MAIN_URI}${CONSTANTS.API.CREATE_ENDPOINT}`, true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        wikiVaultAuth.applyToXhr(xhr);

        setupWritingProgress(xhr, resultContainer, contentAreaContainer, contentArea, previewArea, () => { // Pass content area and preview area
            // Re-enable inputs and buttons after completion (or error handled in setupWritingProgress)
            titleInput.prop('disabled', false);
            contextTextarea.prop('disabled', false);
            writeButton.prop('disabled', false).removeClass('wikivault-button-disabled');

			// Enable save and preview buttons only on success
			saveButton.prop('disabled', false).removeClass('wikivault-button-disabled');
            previewButton.prop('disabled', false).removeClass('wikivault-button-disabled');
        });

        xhr.send(JSON.stringify(payload));
    });
};

const setupWritingProgress = (xhr, resultContainer, contentAreaContainer, contentArea, previewArea, onComplete) => {
    let buffer = {
        text: '',
        lastIndex: 0
    };

    xhr.onreadystatechange = () => {
        if (xhr.readyState === 3 || xhr.readyState === 4) {
            const newText = xhr.responseText.substring(buffer.lastIndex);
            buffer.lastIndex = xhr.responseText.length;
            buffer.text += newText;

            // Hide loading animation when we start receiving content and show content area
            if (buffer.text.length > 0 && resultContainer.find('.loading-dots').is(':visible')) {
                resultContainer.find('.loading-dots').hide();
                contentAreaContainer.show(); // Show the content area container
            }
        }

        if (xhr.readyState === 4) {
            resultContainer.find('.loading-dots').hide();
            contentAreaContainer.show(); // Ensure content area is shown on completion/error
			// Hide the cancel button and clear XHR on completion or error
			wikiVaultCancelButton.hide();
			window.currentWritingXHR = null;
            if (xhr.status !== 200) {
                contentArea.val(contentArea.val() + '\n[Error: 글 생성에 실패했습니다]\n');
				if (xhr.status === 401) {
					wikiVaultAuth.handleUnauthorized();
				} else if (xhr.status === 429) {
					mw.notify('글 생성에 실패했습니다: 한 사용자가 너무 많은 요청 수행', { type: 'error' });
				} else if (xhr.status === 500) {
					mw.notify('글 생성에 실패했습니다: 서버 오류', { type: 'error' });
				} else {
					mw.notify('글 생성에 실패했습니다', { type: 'error' });
				}
				// Re-enable inputs and write button on error
				$('#wikivault-writing-title').prop('disabled', false);
				$('#wikivault-writing-context').prop('disabled', false);
				$('#wikivault-start-writing').prop('disabled', false).removeClass('wikivault-button-disabled');
				// Keep save and preview buttons disabled on error
				$('#wikivault-save-writing').prop('disabled', true).addClass('wikivault-button-disabled');
                $('#wikivault-preview-writing').prop('disabled', true).addClass('wikivault-button-disabled');


			} else if (buffer.text.includes('event: end\ndata: [DONE]')) {
                // Remove the end marker
                const jsonText = buffer.text.replace('event: end\ndata: [DONE]', '');

                try {
                    const jsonData = JSON.parse(jsonText);

                    // Find the last element with groundingMetadata
                    const lastElementWithGrounding = jsonData.findLast(item =>
                        item.candidates?.[0]?.groundingMetadata?.groundingSupports
                    );

                    if (!lastElementWithGrounding) {
                        // Case 3-1: No groundingSupports, concatenate all text parts
                        const allText = jsonData.map(item =>
                            item.candidates?.[0]?.content?.parts?.[0]?.text
                        ).filter(Boolean).join(''); // Filter Boolean handles potential undefined/null texts
                        contentArea.val(allText);
                    } else {
                        // Case 3-2: Has groundingSupports
                        let combinedText = '';
                        const supports = lastElementWithGrounding.candidates[0].groundingMetadata.groundingSupports;
                        const chunks = lastElementWithGrounding.candidates[0].groundingMetadata.groundingChunks;

                        supports.forEach(support => {
                            // Append segment text
                            combinedText += support.segment.text;

                            // Append ref tags for each index
                            if (support.groundingChunkIndices) {
                                support.groundingChunkIndices.forEach(index => {
                                    combinedText += `<ref name=":${index}"/>`;
                                });
								combinedText += " ";
                            }
                        });
                        combinedText = combinedText.replace(/( )+(\[\[분류:)/, "\n$2").replace(/\[\[분류:.*\]\](<ref.*)/, '');

                        // Add footnotes section
                        const footnotesSection = "\n\n== 각주 ==\n{{각주|refs=\n" +
                            Array.from({ length: chunks.length },
                                (_, i) => `<ref name=":${i}"></ref>`).join('\n') +
                            "\n}}\n";

                        // Add footnotes section before categories if they exist
                        if (combinedText.includes("[[분류:")) {
                            combinedText = combinedText.replace(/(\[\[분류:)/, footnotesSection + "$1");
                        } else {
                            combinedText += footnotesSection;
                        }

                        // Create source list container
						const sourceListContainer = $('<div class="wikivault-source-list-container"></div>')
						.css({
						  'position': 'relative',
						  'float': 'left',
						  'left': '0',
						  'bottom': '0',
						  'width': '200px',
						  'max-height': '200px',
						  'overflow-y': 'auto',
						  'padding': '10px',
						  'border-radius': '4px',
						  'z-index': '1000',
						  'font-size': '80%'
						});
					  
						const sourceListEl = sourceListContainer[0];
						sourceListEl.style.setProperty('background-color', 'var(--background-color-base, #fff)');
						sourceListEl.style.setProperty('border', '1px solid var(--border-color-base, #a2a9b1)');

                        // Add source list label
                        sourceListContainer.append($('<div class="wikivault-source-list-label"></div>')
                            .text('출처 목록')
                            .css({
                                'font-weight': 'bold',
                                'margin-bottom': '10px'
                            })
                        );

                        // Add source list items
                        //console.log('Total grounding chunks:', chunks.length);

                        chunks.forEach((chunk, index) => {
                            //console.log('Processing chunk:', index, chunk);
                            const sourceItem = $('<div class="wikivault-source-item"></div>').css({
                                'display': 'flex',
                                'align-items': 'center',
                                'margin-bottom': '5px',
                                'gap': '10px'
                            });

							const removeButton = $('<button class="wikivault-remove-source-btn">-</button>')
							.css({
							  'border': 'none',
							  'border-radius': '4px',
							  'padding': '2px 8px',
							  'cursor': 'pointer'
							});

							const removeButtonEl = removeButton[0];
							removeButtonEl.style.setProperty('background-color', 'var(--background-color-destructive-subtle, #ffe9e5)');
							removeButtonEl.style.setProperty('color', 'var(--color-destructive, #bf3c2c)');						  

                            const addButton = $('<button class="wikivault-add-source-btn">+</button>').css({
                                'background-color': '#007bff',
                                'color': 'white',
                                'border': 'none',
                                'border-radius': '4px',
                                'padding': '2px 8px',
                                'cursor': 'pointer'
                            });

							const sourceLink = $('<a class="wikivault-source-link"></a>')
							.text(chunk.web.title)
							.attr('href', chunk.web.uri)
							.attr('target', '_blank')
							.css({
							  'text-decoration': 'none',
							  'flex': '1',
							  'overflow': 'hidden',
							  'text-overflow': 'ellipsis',
							  'white-space': 'nowrap'
							});
						  
							sourceLink[0].style.setProperty('color', 'var(--color-progressive, #36c)');						  

                            sourceItem.append(removeButton, addButton, sourceLink);
                            sourceListContainer.append(sourceItem);

                            // Handle remove button click
                            removeButton.on('click', function() {
                                // Disable all source items
                                $('.wikivault-source-item').css({
                                    'opacity': '0.5',
                                    'pointer-events': 'none'
                                });

                                try {
                                    // Get current content
                                    const currentContent = contentArea.val();

                                    // Remove the ref tag
                                    const refRegex = new RegExp(`\\s*<ref name=":${index}">.*?</ref>|<ref name=":${index}"/>`, 'g');
                                    const newContent = currentContent.replace(refRegex, '');

                                    // Update the content area with the modified text
                                    contentArea.val(newContent);

                                    // Remove the source item
                                    sourceItem.remove();

                                    mw.notify('출처가 제거되었습니다.', { type: 'success' });
                                } catch (error) {
                                    console.error('Error removing source:', error);
                                    mw.notify('출처를 제거하는데 실패했습니다.', { type: 'error' });
                                } finally {
                                    // Re-enable remaining source items
                                    $('.wikivault-source-item').css({
                                        'opacity': '1',
                                        'pointer-events': 'auto'
                                    });
                                }
                            });

                            // Handle add button click
                            addButton.on('click', async function() {
                                // Disable all source items
                                $('.wikivault-source-item').css({
                                    'opacity': '0.5',
                                    'pointer-events': 'none'
                                });

                                try {
                                    // Fetch the actual URI and page title through server proxy
                                    const response = await fetch(`${CONSTANTS.API.MAIN_URI}/api/get-source-info`, {
                                        method: 'POST',
                                        headers: wikiVaultAuth.headers({ 'Content-Type': 'application/json' }),
                                        body: JSON.stringify({
                                            url: chunk.web.uri
                                        })
                                    });

                                    if (!response.ok) {
                                        throw new Error('Failed to fetch source info');
                                    }

                                    const { pageTitle, actualUri } = await response.json();

                                    // Get current date in YYYY-MM-DD format
                                    const today = new Date().toISOString().split('T')[0];

                                    // Construct the ref tag content
                                    const refContent = `{{웹 인용|url=${actualUri}|제목=${pageTitle}|확인날짜=${today}|출판사=${chunk.web.title} }}`;

                                    // Get the current content from the textarea
                                    let currentContent = contentArea.val();

                                    // Find the placeholder ref tag and replace it with the full ref tag
                                    const refRegex = new RegExp(`<ref name=":${index}"></ref>`);
                                    const newContent = currentContent.replace(refRegex, `<ref name=":${index}">${refContent}</ref>`);

                                    // Update the content area with the modified text
                                    contentArea.val(newContent);

                                    // Remove the source item from the list
                                    sourceItem.remove();

                                    mw.notify('출처가 추가되었습니다.', { type: 'success' });
                                } catch (error) {
                                    console.error('Error fetching source:', error);
                                    mw.notify('출처를 가져오는데 실패했습니다.', { type: 'error' });
                                } finally {
                                    // Re-enable remaining source items
                                    $('.wikivault-source-item').css({
                                        'opacity': '1',
                                        'pointer-events': 'auto'
                                    });
                                }
                            });
                        });

                        // Add source list container to the result container
                        resultContainer.append(sourceListContainer);

                        contentArea.val(combinedText);
                    }
                } catch (e) {
                    console.error('JSON parse error:', e);
                    contentArea.val(contentArea.val() + '\n[Error: 데이터 처리 중 오류가 발생했습니다]\n');
                }

                onComplete();
            }
        }
    };

    xhr.onerror = () => {
        resultContainer.find('.loading-dots').hide();
        contentAreaContainer.show(); // Ensure content area is shown on network error
        contentArea.val(contentArea.val() + '\n[네트워크 오류]\n');
		// Hide the cancel button and clear XHR on network error
		wikiVaultCancelButton.hide();
		window.currentWritingXHR = null;
		// Re-enable inputs and write button on network error
		$('#wikivault-writing-title').prop('disabled', false);
		$('#wikivault-writing-context').prop('disabled', false);
		$('#wikivault-start-writing').prop('disabled', false).removeClass('wikivault-button-disabled');
		// Keep save and preview buttons disabled on network error
		$('#wikivault-save-writing').prop('disabled', true).addClass('wikivault-button-disabled');
        $('#wikivault-preview-writing').prop('disabled', true).addClass('wikivault-button-disabled');

    };
};

const updateWritingPreview = (content, previewArea) => {
    previewArea.empty();

    const loadingDots = $('<div class="loading-dots"><span></span><span></span><span></span></div>');
    previewArea.append(loadingDots);

    const api = new mw.ForeignApi(CONSTANTS.API.WIKIPEDIA_KO);
    const params = {
        format: 'json',
        action: 'parse',
        preview: true,
        disableeditsection: true,
        pst: true,
        title: $('#wikivault-writing-title').val(),
        text: content,
        prop: 'text|categorieshtml|langlinks'
    };

    api.post(params)
        .then(data => {
            previewArea.empty();
            const htmlText = data.parse.text['*'] + (data.parse.categorieshtml ? data.parse.categorieshtml["*"] : '');
            previewArea.html(htmlText);

            previewArea.find('a, button, input, [role="button"]').css({
                'pointer-events': 'none',
                'cursor': 'default'
            }).on('click', function(e) {
                e.preventDefault();
                return false;
            });
        })
        .catch(error => {
            previewArea.empty();
            previewArea.html('<div style="color: red;">❌ 미리보기를 불러오는데 실패했습니다.</div>');
            console.error('Preview failed:', error);
        });
};

//#endregion


//#region 11. Search — Search, search results, existence indicators

const createSearchContainer = () => {
	const textInputIcon = new OO.ui.TextInputWidget({
		value: '',
		placeholder: '주제 검색',
		icon: 'search',
		classes: ['wikivault-search-input']
	});

	const clearButton = new OO.ui.ButtonWidget({
		icon: 'close',
		framed: false,
		invisibleLabel: true,
		classes: ['wikivault-search-clear']
	});

	const container = $('<div class="wikivault-search-container"></div>');
	container.append(textInputIcon.$element, clearButton.$element);
	return container;
};

const setupSearchHandlers = (searchResults, suggestedPagesContainer) => {
	let debounceTimer;
	const textInputIcon = $('.wikivault-search-input');
	const clearButton = $('.wikivault-search-clear');

	textInputIcon.on('input', function() {
		const query = textInputIcon.find('input').val();
		clearTimeout(debounceTimer);

		toggleSuggestedPages(query, suggestedPagesContainer);

		debounceTimer = setTimeout(() => {
			if (query.trim()) {
				updateSearchResults('en', query, searchResults);
			} else {
				searchResults.empty();
			}
		}, 300);
	});

	clearButton.on('click', function() {
		textInputIcon.find('input').val('');
		searchResults.empty();
		toggleSuggestedPages('', suggestedPagesContainer);
	});
};

const toggleSuggestedPages = (query, container) => {
	if (query.trim()) {
		$("#wikivault-suggested-pages-title").hide();
		container.hide();
		$("#wikivault-suggestion-divider").hide();
		$("#wikivault-suggestion-title").hide();
		$("#wikivault-useful-links-divider").hide();
		$("#wikivault-useful-links-title").hide();
		$("#wikivault-useful-links-list").hide();
		$("#wikivault-translation-warning-divider").hide();
		$("#wikivault-translation-warning-message").hide();
	} else {
		$("#wikivault-suggested-pages-title").show();
		container.show();
		$("#wikivault-suggestion-divider").show();
		$("#wikivault-suggestion-title").show();
		$("#wikivault-useful-links-divider").show();
		$("#wikivault-useful-links-title").show();
		$("#wikivault-useful-links-list").show();
		$("#wikivault-translation-warning-divider").show();
		$("#wikivault-translation-warning-message").show();
	}
};

const updateSearchResults = (lang, query, searchResults) => {
	if (!query.trim()) {
		searchResults.empty();
		return;
	}

	wikiVaultSearchTitle(lang, query)
		.done(data => handleSearchSuccess(data, searchResults))
		.fail(handleSearchError);
};

const handleSearchSuccess = (data, searchResults) => {
	searchResults.empty();
	if (data.pages && data.pages.length > 0) {
		// First create all result items
		data.pages.forEach(page => {
			const resultItem = createSearchResultItem(page);
			searchResults.append(resultItem);
		});

		// Then check Korean Wikipedia existence for all items
		const titles = data.pages.map(page => page.title).join('|');
		checkKoreanWikiExistence(titles).then(existenceData => {
			data.pages.forEach((page, index) => {
				const textContainer = searchResults.find('.wikivault-search-result-item').eq(index)
					.find('.wikivault-result-text-container');
				
				// Remove existing indicators if any
				textContainer.find('.ko-wiki-existence-indicator').remove();
				
				// Add new indicator
				const indicator = createExistenceIndicator(existenceData[page.title]);
				textContainer.append(indicator);
			});
		});
	} else {
		searchResults.append("<p style='color: #666; text-align: center;'>검색 결과가 없습니다.</p>");
	}
};

const handleSearchError = (error) => {
	console.error("Search failed:", error);
};

const createSearchResultItem = (page) => {
	const resultItem = $('<div class="wikivault-search-result-item"></div>')
	.on('click', () => showDocModal(page.title));

	const img = createThumbnail(page);
	const textContainer = createTextContainer(page).addClass('wikivault-result-text-container');

	resultItem.append(img, textContainer);
	return resultItem;
};

const createThumbnail = (page) => {
	if (page.thumbnail && page.thumbnail.url) {
		return $('<img>').attr('src', page.thumbnail.url).css({
			'width': '40px',
			'height': '40px',
			'margin-right': '10px',
			'border-radius': '5px',
			'object-fit': 'cover'
		});
	}

	return createPlaceholderThumbnail();
};

const createPlaceholderThumbnail = () => {
	return $('<div></div>').css({
		'width': '40px',
		'height': '40px',
		'margin-right': '10px',
		'border-radius': '5px',
		'background-color': '#f0f0f0',
		'display': 'flex',
		'align-items': 'center',
		'justify-content': 'center'
	}).html(`
		<span class="cdx-thumbnail__placeholder">
			<span class="cdx-icon cdx-icon--medium cdx-thumbnail__placeholder__icon--vue">
				<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20">
					<g>
						<path d="M19 3H1v14h18zM3 14l3.5-4.5 2.5 3L12.5 8l4.5 6z"></path>
						<path d="M19 5H1V3h18zm0 12H1v-2h18z"></path>
					</g>
				</svg>
			</span>
		</span>
	`);
};

const createTextContainer = (page) => {
	const container = $('<div class="wikivault-result-text-container"></div>').css({
		'display': 'flex',
		'flex-direction': 'column',
		'flex': '1',
		'min-width': '0', // This is crucial for text truncation in flex containers
		'padding-right': '80px'
	});

	const title = $('<span></span>').text(page.title).css({
		'font-size': '90%',
		'font-weight': 'bold',
		'margin-bottom': '2px',
		'color': 'inherit',
		'display': 'block',
		'overflow': 'hidden',
		'text-overflow': 'ellipsis',
		'white-space': 'nowrap',
		'width': '100%'
	});

	const description = $('<span></span>').text(page.description || '설명 없음').css({
		'font-size': '80%',
		'color': '#666',
		'overflow': 'hidden',
		'text-overflow': 'ellipsis',
		'white-space': 'nowrap',
		'display': 'block',
		'width': '100%'
	});

	container.append(title, description);
	return container;
};

const createExistenceIndicator = (existenceData) => {
	if (!existenceData) return $('<div>').css('display', 'none');

	const container = $('<div>')
		.addClass('ko-wiki-indicator-container')
		.addClass('ko-wiki-existence-indicator')
		.css({
			'position': 'absolute',
			'right': '10px',
			'top': '50%',
			'transform': 'translateY(-50%)',
			'display': 'flex',
			'flex-direction': 'column',
			'align-items': 'flex-end'
		});

	const indicator = $('<div class="ko-wiki-indicator"></div>')
		.css({
			'padding': '4px 8px',
			'border-radius': '4px',
			'font-size': '12px',
			'font-weight': 'bold',
			'cursor': 'pointer'
		})
		.text(existenceData.exists ? '한국어로 있음' : '한국어로 없음');
  
	const indicatorEl = indicator[0];
	indicatorEl.style.setProperty(
		'background-color',
		existenceData.exists
			? 'var(--background-color-success-subtle, #dff2eb)'
			: 'var(--background-color-destructive-subtle, #ffe9e5)'
	);
	indicatorEl.style.setProperty(
		'color',
		existenceData.exists
			? 'var(--color-success, #177860)'
			: 'var(--color-destructive, #bf3c2c)'
	);

	// Add language count indicator
	const langCountIndicator = $('<div>')
		.css({
			'font-size': '10px',
			'color': 'inherit',
			'margin-top': '2px'
		})
		.text(`+${existenceData.langCount}개 언어로 작성됨`);

	container.append(indicator);
	container.append(langCountIndicator);

	// Add click handler for both cases
	indicator.on('click', (e) => {
		e.stopPropagation(); // Prevent triggering parent's click event
		let url;
		if (existenceData.exists && existenceData.koTitle) {
			url = `https://ko.wikipedia.org/wiki/${encodeURIComponent(existenceData.koTitle)}`;
		} else {
			url = `https://ko.wikipedia.org/wiki/Special:Search/${encodeURIComponent(existenceData.title)}`;
		}
		window.open(url, '_blank');
	});

	// Add tooltip
	if (existenceData.exists && existenceData.koTitle) {
		indicator.attr('title', existenceData.koTitle);
	} else {
		indicator.attr('title', '한국어 위키백과에서 검색');
	}

	return container;
};

// Show search results in a modal
const showSearchResultsModal = (results) => {
    // Remove existing modal if any
    $('#wikivault-search-results-modal').remove();

    const modal = $('<div id="wikivault-search-results-modal"></div>')
        .addClass('wikivault-modal') // Reuse modal styling
        .css({
            'top': '15%',
            'left': '50%',
            'transform': 'translateX(-50%)',
            'width': 'min(90%, 600px)',
            'height': 'min(70%, 500px)',
            'z-index': 1005, // Ensure it's above other modals
            'display': 'flex',
            'flex-direction': 'column'
        })
        .appendTo('body');

    const modalHeader = $('<div></div>').css({
        'display': 'flex',
        'justify-content': 'space-between',
        'align-items': 'center',
        'margin-bottom': '15px'
    }).appendTo(modal);

    $('<h3>검색 결과</h3>').css('margin', '0').appendTo(modalHeader);

    const closeButton = $('<div class="wikivault-close-btn"></div>') // Reuse close button styling
        .html('<svg style="fill: var(--color-base, #202122);" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">' +
              '<path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>' +
              '</svg>')
        .appendTo(modalHeader);

    // Textarea container with copy icon
    const textareaContainer = $('<div></div>').addClass('wikivault-textarea-container').css({
        'flex': '1', // Allow textarea to fill available space
        'min-height': '0',
        'display': 'flex',
        'flex-direction': 'column',
        'position': 'relative'
    }).appendTo(modal);

	const resultsTextarea = $('<textarea readonly></textarea>')
	.addClass('wikivault-doc-modal-edit') // Reuse textarea styling
	.css({
	  'flex': '1',
	  'height': '100%',
	  'box-sizing': 'border-box',
	  'resize': 'none',
	  ...(SHOW_COPY_ICON ? { 'padding-right': '35px !important' } : {})
	})
	.val(results.join('\n'))
	.appendTo(textareaContainer);
  
	const resultsTextareaEl = resultsTextarea[0];
	resultsTextareaEl.style.setProperty('background-color', 'var(--background-color-base, #fff)');
	resultsTextareaEl.style.setProperty('color', 'var(--color-base, #202122)');  

    const copyIcon = createCopyIcon();
    textareaContainer.append(copyIcon);

    // Event handlers
    closeButton.on('click', () => {
        modal.hide();
    });

    copyIcon.on('click', () => {
        copyTextToClipboard(resultsTextarea.val());
    });

    modal.show();
};

//#endregion


//#region 12. Suggested Pages — Suggested pages

const createSuggestedPagesContainer = () => {
	const container = $('<div id="wikivault-suggested-pages" class="wikivault-suggested-container"></div>');
	const title = $("<p id='wikivault-suggested-pages-title' class='wikivault-suggested-title' style='margin-top: 20px; font-size: 90%; font-weight: bold;'>&#x1F4CC; 번역할 문서 제안:</p>");
	container.before(title);
	return container;
};

const fetchSuggestedPages = () => {
	$.ajax({
		url: CONSTANTS.API.MAIN_URI + CONSTANTS.API.SUGGESTED_PAGES_ENDPOINT,
		method: "GET",
		dataType: "json",
		success: handleSuggestedPagesSuccess,
		error: handleSuggestedPagesError
	});
};

const handleSuggestedPagesSuccess = (response) => {
	const container = $('#wikivault-suggested-pages');
	container.empty();

	CONSTANTS.CATEGORIES.forEach(category => {
		if (response[category.key]?.length > 0) {
			const categoryBox = createCategoryBox(category, response[category.key]);
			container.append(categoryBox);
		}
	});
};

const handleSuggestedPagesError = (xhr, status, error) => {
	console.error("❌ 번역 문서 제안 데이터를 가져오는데 실패:", error);
	$('#wikivault-suggested-pages').append(
		"<p style='color: red;'>❌ 데이터를 불러오는 중 오류가 발생했습니다.</p>"
	);
};

const createCategoryBox = (category, titles) => {
	const box = $('<div class="wikivault-category-box"></div>');
	box[0].style.setProperty('background-color', category.bgColor);

	const title = $('<p class="wikivault-category-title"></p>').text(category.label);
	title[0].style.setProperty('color', category.textColor);

	box.append(title);
	box.append(createDocumentContainer(category, titles));
	return box;
};

const createDocumentContainer = (category, titles) => {
	const container = $('<div class="wikivault-doc-list-container"></div>');

	const docs = titles.map(title => ({
		full: title,
		short: title.length > 20 ? title.substring(0, 17) + "..." : title
	}));

	const docView = createDocumentView(category, docs);
	const arrows = createNavigationArrows(category, docs, docView);

	container.append(arrows.left, docView, arrows.right);
	return container;
};

const createDocumentView = (category, docs) => {
	return $('<div class="wikivault-doc-view"></div>').css({
		'display': 'flex',
		'gap': '10px',
        'overflow': 'hidden',
		'width': 'calc(100% - 40px)'
	});
};

// Renders the documents for the current view
const renderDocs = (docs, currentIndex, docView) => {
	docView.empty();

	// Determine how many items to show based on container width
	// Use a threshold (e.g., 400px) to switch from 2 items to 1
	const containerWidth = docView.width();
	const itemsToShow = containerWidth > 400 ? 2 : 1; // Adjust threshold as needed

	const slicedDocs = docs.slice(currentIndex, currentIndex + itemsToShow);
	slicedDocs.forEach(doc => {
		const docItem = createDocItem(doc);
		docView.append(docItem);
	});

	// Update arrow visibility/state based on the new itemsToShow value
	docView.siblings('.wikivault-arrow-left').css('opacity', currentIndex === 0 ? '0.3' : '1').css('pointer-events', currentIndex === 0 ? 'none' : 'auto');
	docView.siblings('.wikivault-arrow-right').css('opacity', currentIndex + itemsToShow >= docs.length ? '0.3' : '1').css('pointer-events', currentIndex + itemsToShow >= docs.length ? 'none' : 'auto');
};

const createNavigationArrows = (category, docs, docView) => {
	let currentIndex = 0;

	const leftArrow = $('<span class="wikivault-arrow-left">◀</span>').css({
		'cursor': 'pointer',
		'font-size': '16px',
		'color': category.textColor,
		'user-select': 'none',
		'opacity': '0.3', // Initially disabled
		'pointer-events': 'none' // Initially disabled
	}).on('click', () => {
		const containerWidth = docView.width();
		const itemsToShow = containerWidth > 400 ? 2 : 1; // Match threshold

		if (currentIndex > 0) {
			currentIndex = Math.max(0, currentIndex - itemsToShow); // Adjust index jump
			renderDocs(docs, currentIndex, docView);
		}
	});

	const rightArrow = $('<span class="wikivault-arrow-right">▶</span>').css({
		'cursor': 'pointer',
		'font-size': '16px',
		'color': category.textColor,
		'user-select': 'none'
	}).on('click', () => {
		const containerWidth = docView.width();
		const itemsToShow = containerWidth > 400 ? 2 : 1; // Match threshold

		if (currentIndex + itemsToShow < docs.length) {
			currentIndex = Math.min(docs.length - itemsToShow, currentIndex + itemsToShow); // Adjust index jump
			renderDocs(docs, currentIndex, docView);
		}
	});

	// Initial render
	renderDocs(docs, currentIndex, docView);

	// Add ResizeObserver to re-render on size changes
	if (typeof ResizeObserver !== 'undefined') {
		const resizeObserver = new ResizeObserver(entries => {
			// Check if the width has changed significantly (e.g., crossed the threshold)
			const newItemsToShow = entries[0].contentRect.width > 400 ? 2 : 1; // Match threshold
			const currentItemsShown = docView.children().length;

			if (newItemsToShow !== currentItemsShown) {
				// Adjust currentIndex if needed to stay within bounds after switching item count
				currentIndex = Math.min(currentIndex, docs.length - newItemsToShow);
				if (currentIndex < 0) currentIndex = 0;
				renderDocs(docs, currentIndex, docView);
			}
		});

		resizeObserver.observe(docView[0]);
	}

	return { left: leftArrow, right: rightArrow };
};

const createDocItem = (doc) => {
	return $('<div class="wikivault-doc-item"></div>').text(doc.full)
	.attr('title', doc.full)
	.on('click', function() {
		showDocModal($(this).attr('title'));
	});
};

//#endregion


//#region 13. Command Palette — Command palette, floating button toggle, hotkey

const createCommandPaletteUI = () => {
	wikiVaultCommandPalette = $('<div id="wikivault-command-palette"></div>')
		.addClass('wikivault-command-palette')
		.appendTo('body');

	const inputContainer = $('<div></div>').css({
		'display': 'flex',
		'align-items': 'center',
		'gap': '10px',
		'padding-right': '20px'
	}).appendTo(wikiVaultCommandPalette);

	// Create input wrapper
	const inputWrapper = $('<div class="wikivault-input-wrapper"></div>')
		.css({
        'position': 'relative',
			'display': 'inline-block',
			'width': '100%'
		})
		.appendTo(inputContainer);

	wikiVaultCommandInput = $('<input type="text" id="wikivault-command-input" autocomplete="off">')
		.addClass('wikivault-command-input')
		.attr('placeholder', '명령을 입력하세요...')
		.css({
			'width': '100%',
			'padding-right': '30px',
			'box-sizing': 'border-box'
		})
		.appendTo(inputWrapper);

	// Add info icon
	const infoIcon = $('<span class="wikivault-command-info">ⓘ</span>')
	.css({
	  'position': 'absolute',
	  'right': '10px',
	  'top': '50%',
	  'transform': 'translateY(-50%)',
	  'cursor': 'pointer',
	  'font-size': '16px',
	  'z-index': '1'
	})
	.appendTo(inputWrapper);  
	infoIcon[0].style.setProperty('color', 'var(--color-base--subtle, #54595d)');  

	// Create info popup
	const infoPopup = $('<div class="wikivault-command-info-popup"></div>')
	.css({
	  'position': 'absolute',
	  'top': '100%',
	  'right': '0',
	  'border-radius': '4px',
	  'padding': '15px',
	  'margin-top': '5px',
	  'box-shadow': '0 2px 5px rgba(0,0,0,0.2)',
	  'z-index': '2001',
	  'display': 'none',
	  'width': '300px',
	  'max-width': '90vw'
	})
	.appendTo(inputWrapper);
  
	const popupEl = infoPopup[0];
	popupEl.style.setProperty('background', 'var(--background-color-base, #fff)');
	popupEl.style.setProperty('border', '1px solid var(--border-color-base, #a2a9b1)');

	// Add close button to info popup
	const closeButton = $('<button class="wikivault-command-info-close">×</button>')
	.css({
	  'position': 'absolute',
	  'top': '5px',
	  'right': '5px',
	  'background': 'none',
	  'border': 'none',
	  'font-size': '20px',
	  'cursor': 'pointer',
	  'padding': '0 5px'
	})
	.appendTo(infoPopup);
  
	closeButton[0].style.setProperty('color', 'var(--color-base--subtle, #54595d)');

	// Add content to info popup
	const infoContent = $('<div class="wikivault-command-info-content"></div>')
		.css({
			'margin-top': '10px'
		})
		.appendTo(infoPopup);

	// Create command list
	const commands = [
		{ cmd: '/e, /edit {title}', desc: '편집' },
		{ cmd: '/ve, /vedit {title}', desc: '시각 편집' },
		{ cmd: '/d, /delete {title}', desc: '삭제' },
		{ cmd: '/m, /move {title}', desc: '이동' },
		{ cmd: '/h, /history {title}', desc: '역사' },
		{ cmd: '/b, /block {title}', desc: '차단' },
		{ cmd: '/r, /read {title}', desc: '읽기' },
		{ cmd: '/rc, /recentchanges', desc: '최근 바뀜' },
		{ cmd: '/ft, /filter', desc: '편집 필터' }
	];

	// Create command list with grid layout
	const commandList = $('<div class="wikivault-command-list"></div>')
		.css({
			'display': 'grid',
			'grid-template-columns': 'auto 1fr',
			'gap': '8px 15px',
			'align-items': 'center'
		});

	commands.forEach(({ cmd, desc }) => {
		const cmdCell = $('<div></div>')
			.text(cmd)
			.css({
				'font-family': 'monospace'
			});
	
		cmdCell[0].style.setProperty('color', 'var(--color-progressive, #36c)');
	
		const descCell = $('<div></div>').text(desc);
		commandList.append(cmdCell, descCell);
	});

	infoContent.append(commandList);

	// Add title to info popup
	$('<div class="wikivault-command-info-title"></div>')
		.text('사용법')
		.css({
			'font-weight': 'bold',
			'margin-bottom': '10px'
		})
		.prependTo(infoContent);

	// Toggle info popup
	infoIcon.on('click', (e) => {
		e.stopPropagation();
		infoPopup.toggle();
	});

	// Close info popup when clicking outside
	$(document).on('click', (e) => {
		if (!$(e.target).closest('.wikivault-command-info-popup, .wikivault-command-info').length) {
			infoPopup.hide();
		}
	});

	// Close info popup when pressing Ctrl-Alt-M or clicking close button
	closeButton.on('click', () => {
		infoPopup.hide();
	});

	wikiVaultCommandInput.on('keydown', function(e) {
		if (e.key === 'Enter') {
			e.preventDefault();
			handleSendCommand();
		}
		if (e.key === 'Escape') {
			e.preventDefault();
			hideCommandPalette();
		}
	});

	const sendButton = $('<button></button>')
		.addClass('wikivault-button-primary')
		.html('<svg style="fill: white; width: 24px; height: 24px;" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">' +
        '<g transform="rotate(-45 12 12)">' +
        '<path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>' +
        '</g>' +
        '</svg>'
        ).appendTo(inputContainer);

	const commandCloseButton = $('<div id="wikivault-command-close-btn"></div>')
		.addClass('wikivault-close-btn')
		.html('<svg style="fill: white;" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">' +
			'<path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>' +
			'</svg>')
		.appendTo(wikiVaultCommandPalette);

	commandCloseButton.on('click', () => {
		hideCommandPalette();
		infoPopup.hide(); // Also hide info popup when closing command palette
	});
	sendButton.on('click', handleSendCommand);
};

const showCommandPalette = () => {
	if (wikiVaultCommandPalette) {
		wikiVaultCommandPalette.show();
		wikiVaultCommandInput.focus(); // Focus the input when shown
	}
};

const hideCommandPalette = () => {
	if (wikiVaultCommandPalette) {
		wikiVaultCommandPalette.hide();
		wikiVaultCommandInput.val(''); // Clear input on hide
	}
};

const toggleCommandPalette = () => {
	if (wikiVaultCommandPalette) {
		if (wikiVaultCommandPalette.is(':visible')) {
			hideCommandPalette();
		} else {
			showCommandPalette();
		}
	}
};

const toggleFloatingButton = () => {
	const isDocModalVisible = wikiVaultDocModal.is(':visible');
	const isMainModalVisible = wikiVaultModalWindow.is(':visible');

	if (window.wikiVault.isHotkeyActive) {
		// Hotkey is active, means we are trying to restore the previous state
		if (window.wikiVault.hotkeyState) {
			if (window.wikiVault.hotkeyState.mainVisible) {
				wikiVaultModalWindow.show();
				wikiVaultOverlay.show();
				//wikiVaultFloatingButton.hide();
			} else {
				// If main was not visible, ensure it's hidden and floating button is shown
				wikiVaultModalWindow.hide();
				wikiVaultOverlay.hide();
				//wikiVaultFloatingButton.show();
			}

			if (window.wikiVault.hotkeyState.docVisible) {
				wikiVaultDocModal.show();
			} else {
				wikiVaultDocModal.hide();
			}
		}
		// Reset hotkey state after restoring (or attempting to restore)
		window.wikiVault.isHotkeyActive = false;
		window.wikiVault.hotkeyState = null;

	} else {
		// Hotkey is not active, means we are trying to hide the current state or show main
		if (isDocModalVisible) {
			// Scenario 1: Doc modal is open. Hide both and store state.
			window.wikiVault.hotkeyState = {
				mainVisible: isMainModalVisible, // Should be true here
				docVisible: isDocModalVisible // Should be true here
			};
			wikiVaultDocModal.hide();
			wikiVaultModalWindow.hide();
			wikiVaultOverlay.hide();
			//wikiVaultFloatingButton.show(); // Show floating button when all are hidden
			window.wikiVault.isHotkeyActive = true;
		} else if (isMainModalVisible) {
			// Scenario 2: Only main modal is visible. Hide main.
			wikiVaultModalWindow.hide();
			wikiVaultOverlay.hide();
			//wikiVaultFloatingButton.show();
			// No need to set isHotkeyActive or store state for this simple hide
		} else {
			// Scenario 3: Both are hidden. Show main.
			wikiVaultModalWindow.show();
			wikiVaultOverlay.show();
			//wikiVaultFloatingButton.hide();
			// No need to set isHotkeyActive or store state for these simple show
		}
	}
};

const handleSendCommand = () => {
	const commandInput = wikiVaultCommandInput.val().trim();

	if (!commandInput) {
		// Ignore empty or whitespace-only input
		return;
	}

	const parts = commandInput.split(' ');
	const command = parts[0].toLowerCase();
	const argument = parts.slice(1).join(' ');
	const encodedArgument = encodeURIComponent(argument);

	let url = '';
	let handled = true;

	switch (command) {
		case '/e':
		case '/ed':
		case '/edit':
			if (argument) {
				url = `https://ko.wikipedia.org/w/index.php?action=edit&title=${encodedArgument}`;
			} else {
				if ($("#ca-edit a").length && $("#ca-edit a").attr("href")) {
					url = $("#ca-edit a").attr("href");
				} else if ($("#ca-edit").length && $("#ca-edit").attr("href")) {
					url = $("#ca-edit").attr("href");
				} else {
					handled = false; // Treat as search if no argument
				}
			}
			break;
		case '/ve':
		case '/ved':
		case '/vedit':
			if (argument) {
				url = `https://ko.wikipedia.org/w/index.php?veaction=edit&title=${encodedArgument}`;
			} else {
				if ($("#ca-ve-edit a").length && $("#ca-ve-edit a").attr("href")) {
					url = $("#ca-ve-edit a").attr("href");
				} else {
					handled = false; // Treat as search if no argument
				}
			}
			break;
		case '/d':
		case '/del':
		case '/delete':
			if (argument) {
				url = `https://ko.wikipedia.org/w/index.php?action=delete&title=${encodedArgument}`;
			} else {
				if ($("#ca-delete a").length && $("#ca-delete a").attr("href")) {
					url = $("#ca-delete a").attr("href");
				} else {
					handled = false; // Treat as search if no argument
				}
			}
			break;
		case '/m':
		case '/move':
			if (argument) {
				url = `https://ko.wikipedia.org/wiki/Special:MovePage/${encodedArgument}`;
			} else {
				if ($("#ca-move a").length && $("#ca-move a").attr("href")) {
					url = $("#ca-move a").attr("href");
				} else {
					handled = false; // Treat as search if no argument
				}
			}
			break;
		case '/h':
		case '/history':
			if (argument) {
				url = `https://ko.wikipedia.org/w/index.php?action=history&title=${encodedArgument}`;
			} else {
				if ($("#ca-history a").length && $("#ca-history a").attr("href")) {
					url = $("#ca-history a").attr("href");
				} else {
					handled = false; // Treat as search if no argument
				}
			}
			break;
		case '/b':
		case '/block':
			if (argument) {
				url = `https://ko.wikipedia.org/wiki/Special:Block/${encodedArgument}`;
			} else {
				if ($("#t-blockip a").length && $("#t-blockip a").attr("href")) {
					url = $("#t-blockip a").attr("href");
				} else {
					handled = false; // Treat as search if no argument
				}
			}
			break;
		case '/r':
		case '/read':
			if (argument) {
				url = `https://ko.wikipedia.org/w/index.php?search=${encodedArgument}&title=Special:Search`;
			} else {
				handled = false; // Treat as search if no argument
			}
			break;
		case '/rc':
		case '/recentchanges':
			url = `https://ko.wikipedia.org/wiki/Special:RecentChanges`;
			break;
		case '/ft':
		case '/filter':
			url = `https://ko.wikipedia.org/wiki/Special:AbuseFilter`;
			break;
		case '/np':
		case '/newpages':
			url = `https://ko.wikipedia.org/wiki/Special:NewPages`;
			break;
		case '/t1':
			url = `https://ko.wikipedia.org/w/index.php?title=%ED%8A%B9%EC%88%98:%EA%B2%80%EC%83%89&limit=5000&offset=0&ns0=1&search=-hastemplate%3A%22%EC%9C%84%ED%82%A4%EB%8D%B0%EC%9D%B4%ED%84%B0+%EC%86%8D%EC%84%B1+%EC%B6%94%EC%A0%81%22+-incategory%3A%22%EB%AA%A8%EB%93%A0+%EB%8F%99%EC%9D%8C%EC%9D%B4%EC%9D%98%EC%96%B4+%EB%AC%B8%EC%84%9C%22+-hastemplate%3A%22%EB%84%98%EB%82%98%EB%93%A4%EA%B8%B0%22+-hastemplate%3A%22%EC%9C%84%ED%82%A4%EB%82%B1%EB%A7%90%EC%82%AC%EC%A0%84+%EB%84%98%EA%B2%A8%EC%A3%BC%EA%B8%B0%22+-hastemplate%3A%22%EC%83%89%EC%9D%B8+%EB%AA%A8%EC%9D%8C+%EB%AC%B8%EC%84%9C%22+-hastemplate%3A%22%EC%82%AD%EC%A0%9C+%EC%8B%A0%EC%B2%AD%22+-hastemplate%3A%22%EC%82%AD%EC%A0%9C+%ED%86%A0%EB%A1%A0%2F%ED%95%B5%EC%8B%AC%22+-hastemplate%3A%22%EC%84%B1%EC%94%A8%22+-hastemplate%3A%22%ED%9A%A8%EC%86%8C+%EC%83%89%EC%9D%B8%22+-hastemplate%3A%22%EC%9C%84%ED%82%A4%EB%AC%B8%ED%97%8C+%EB%84%98%EA%B2%A8%EC%A3%BC%EA%B8%B0%22+-hastemplate%3A%22%EC%9C%84%ED%82%A4%EC%B1%85+%EB%84%98%EA%B2%A8%EC%A3%BC%EA%B8%B0%22+-hastemplate%3A%22%EC%82%AD%EC%A0%9C+%EC%A0%9C%EC%95%88%22`;
			break;
		case '/t2':
			url = `https://ko.wikipedia.org/w/index.php?search=-hastemplate%3A%22%EC%82%AD%EC%A0%9C+%EC%8B%A0%EC%B2%AD%22+-hastemplate%3A%22%EC%82%AD%EC%A0%9C+%EC%A0%9C%EC%95%88%22+-hastemplate%3A%22%EC%82%AD%EC%A0%9C+%ED%86%A0%EB%A1%A0%22+-hastemplate%3A%22%EC%82%AD%EC%A0%9C+%ED%86%A0%EB%A1%A0%2F%ED%95%B5%EC%8B%AC%22+-hastemplate%3A%22%ED%8A%B9%EC%A0%95%ED%8C%90+%EC%82%AD%EC%A0%9C+%EC%8B%A0%EC%B2%AD%22+-hastemplate%3A%22%EB%B6%84%EB%A5%98+%ED%95%84%EC%9A%94%22+-incategory%3A%22%EB%AA%A8%EB%93%A0+%EB%8F%99%EC%9D%8C%EC%9D%B4%EC%9D%98%EC%96%B4+%EB%AC%B8%EC%84%9C%22+-hastemplate%3A%22%EC%83%89%EC%9D%B8+%EB%AA%A8%EC%9D%8C+%EB%AC%B8%EC%84%9C%22+-hastemplate%3A%22%EC%9C%84%ED%82%A4%EB%82%B1%EB%A7%90%EC%82%AC%EC%A0%84+%EB%84%98%EA%B2%A8%EC%A3%BC%EA%B8%B0%22+-hastemplate%3A%22%EC%9C%84%ED%82%A4%EB%AC%B8%ED%97%8C+%EB%84%98%EA%B2%A8%EC%A3%BC%EA%B8%B0%22+-hastemplate%3A%22%EC%9C%84%ED%82%A4%EC%B1%85+%EB%84%98%EA%B2%A8%EC%A3%BC%EA%B8%B0%22+-hastemplate%3A%22%EC%84%B1%EC%94%A8%22+-hastemplate%3A%22%ED%99%94%ED%95%99+%EC%83%89%EC%9D%B8%22+-hastemplate%3A%22%ED%9A%A8%EC%86%8C+%EC%83%89%EC%9D%B8%22+-insource%3A%22%EB%B6%84%EB%A5%98%3A%22&title=%ED%8A%B9%EC%88%98%3A%EA%B2%80%EC%83%89&ns0=1&searchToken=bk7ado9mxcgiiy5nlyfjankx&limit=5000`;
			break;
		case '/get':
			if (mw.config.get('wgNamespaceNumber') === -1 && mw.config.get('wgCanonicalSpecialPageName') === 'Search') {
				let tmpCon = $('body').html().split(/\n/);
				let resCon = [];
				for (let i=0; i<tmpCon.length; i++) {
					let line = tmpCon[i];
					if (/ data-serp-pos="/.test(line)) {
						line = line.replace(/^.*mw-search-results/i, "");
						let tmpCon2 = line.split(/data-serp-pos="/);
						for (let i2=0; i2<tmpCon2.length; i2++) {
							let line2 = tmpCon2[i2];
							if (/ title="/.test(line2)) {
								if (!/(쪽마다|"extiw")/.test(line2)) {
									resCon.push(line2.replace(/.* title="/, "").replace(/".*/, ""));
								}
							}
						}
					}
				}
				if (resCon.length) {
					resCon = [...new Set(resCon)];
					//console.log(resCon);
					showSearchResultsModal(resCon); // Call the new function here
				}
			}
			break;
		default:
			handled = false; // Treat as search for unknown commands
			break;
	}

	if (!handled) {
		// Default to search if command is unknown or argument is missing for commands that require it
		url = `https://ko.wikipedia.org/w/index.php?search=${encodeURIComponent(commandInput)}&title=Special:Search`;
	}

	if (url) {
		window.location.href = url; // Redirect in the current tab
	}

	// mw.notify('명령 실행: "' + command + '" (기능 구현 필요)', { type: 'info' }); // Remove or modify this notification
	hideCommandPalette(); // Hide after sending
};

const setupModalHotkey = () => {
	$(document).on('keydown', function(e) {
		// Check for Ctrl-Alt-M to toggle the command palette
		if (e.ctrlKey && e.altKey && e.key === 'm') {
			e.preventDefault(); // Prevent default browser action
			toggleCommandPalette(); // Call the function to toggle the command palette
		}

		// Check for Ctrl-Alt-A to toggle the modal visibility
		if (e.ctrlKey && e.altKey && e.key === 'a' && wikiVaultInitialized) {
			e.preventDefault(); // Prevent default browser action
			toggleFloatingButton();
		}
	});
};

//#endregion


//#region 14. Settings & Info — Settings, info modal

const setupSettingsHandlers = () => {
	const thinkingEnabled = $('#wikivault-setting-thinking-enabled');
	const thinkingSlider = $('#wikivault-setting-thinking-slider'); // Get the new slider
	const thinkingValueSpan = $('#wikivault-setting-thinking-value'); // Get the new value span
	const temperatureAuto = $('#wikivault-setting-temperature-auto');
	const temperatureSlider = $('#wikivault-setting-temperature-slider');
	const temperatureValueSpan = $('#wikivault-setting-temperature-value');
	const resetDefaultsButton = $('#wikivault-setting-reset-defaults');

	// Load settings from localStorage or use defaults
	loadSettings();

	// Event listeners
	temperatureAuto.on('change', function() {
		temperatureSlider.val('0.7').trigger('input');
		temperatureSlider.prop('disabled', this.checked);
		saveSettings();
	});

	temperatureSlider.on('input', function() {
		temperatureValueSpan.text(this.value);
		saveSettings();
	});

	thinkingEnabled.on('change', function() {
		const isChecked = this.checked;
		thinkingSlider.prop('disabled', !isChecked);
		// If disabled, reset slider to default and update display
		if (!isChecked) {
			thinkingSlider.val('1024').trigger('input'); // Set to default value
		}
		saveSettings();
	});

	// Add input handler for the new thinking slider
	thinkingSlider.on('input', function() {
		const value = parseInt(this.value);
		thinkingValueSpan.text(value === 0 ? '자동' : value); // Display '자동' if 0, otherwise value
		saveSettings();
	});


	resetDefaultsButton.on('click', function() {
		thinkingEnabled.prop('checked', false).trigger('change'); // Trigger change to disable slider and update display
		temperatureSlider.val('0.7').trigger('input');
		temperatureAuto.prop('checked', true).trigger('change');
		saveSettings();
		mw.notify('설정이 기본값으로 초기화되었습니다.', { type: 'success' });
	});

	// Add event listener for the new checkbox
	$('#wikivault-attach-translation-template').on('change', saveSettings);
};

const saveSettings = () => {
	const settings = {
		thinkingEnabled: $('#wikivault-setting-thinking-enabled').is(':checked'),
		thinkingAmount: $('#wikivault-setting-thinking-slider').val(),
		temperature: $('#wikivault-setting-temperature-slider').val(),
		temperatureAuto: $('#wikivault-setting-temperature-auto').is(':checked'),
		attachTranslationTemplate: $('#wikivault-attach-translation-template').is(':checked')
	};
	localStorage.setItem('wikivaultSettings', JSON.stringify(settings));
};

const loadSettings = () => {
	const settings = JSON.parse(localStorage.getItem('wikivaultSettings'));
	if (settings) {
		$('#wikivault-setting-thinking-enabled').prop('checked', settings.thinkingEnabled).trigger('change');
		$('#wikivault-setting-temperature-auto').prop('checked', settings.temperatureAuto);
		$('#wikivault-setting-temperature-slider').val(settings.temperature);
		$('#wikivault-setting-temperature-slider').prop('disabled', settings.temperatureAuto);
		$('#wikivault-setting-temperature-value').text(settings.temperature);

		const thinkingAmount = settings.thinkingAmount !== undefined ? settings.thinkingAmount : 1024;
		$('#wikivault-setting-thinking-slider').val(thinkingAmount);
		$('#wikivault-setting-thinking-value').text(thinkingAmount === 0 ? '자동' : thinkingAmount);
		$('#wikivault-setting-thinking-slider').prop('disabled', !settings.thinkingEnabled);

		// Load new setting, default to false if not present
		$('#wikivault-attach-translation-template').prop('checked', settings.attachTranslationTemplate || false);

	} else {
		// Apply default settings if none found
		$('#wikivault-setting-thinking-enabled').prop('checked', false);
		$('#wikivault-setting-temperature-auto').prop('checked', true);
		$('#wikivault-setting-temperature-slider').val('0.7');
		$('#wikivault-setting-temperature-slider').prop('disabled', true);
		$('#wikivault-setting-temperature-value').text('0.7');

		// Apply default thinking amount
		$('#wikivault-setting-thinking-slider').val('1024');
		$('#wikivault-setting-thinking-slider').prop('disabled', true); // Default is disabled
		$('#wikivault-setting-thinking-value').text('1024');

		// Set default for new checkbox if no settings found
		$('#wikivault-attach-translation-template').prop('checked', false);
	}
};

const showSettingsModal = () => {
	const modal = $('<div class="wikivault-modal wikivault-settings-modal"></div>')
		.css({
			'position': 'fixed',
			'top': '50%',
			'left': '50%',
			'transform': 'translate(-50%, -50%)',
			'background': 'var(--background-color-base, #fff)',
			'padding': '20px',
			'border-radius': '8px',
			'box-shadow': '0 2px 10px rgba(0,0,0,0.1)',
			'z-index': '1004',
			'max-width': '500px',
			'width': '90%',
			'max-height': '90vh',
			'overflow-y': 'auto',
			'overflow-x': 'hidden',
			'display': 'block'
		});

	const content = $(`
		<div id="wikivault-settings-area" class="wikivault-settings-container">
			<h2 class="wikivault-settings-header">설정</h2>
			<div class="wikivault-settings-section">
				<p class="wikivault-settings-title">AI 설정</p>
				<div class="wikivault-settings-content">
					<div class="wikivault-settings-item">
						<div class="wikivault-settings-label-wrapper">
							<label class="wikivault-settings-label">Thinking</label>
						</div>
						<div class="wikivault-settings-control-group">
							<div class="wikivault-settings-option">
								<input type="checkbox" id="wikivault-setting-thinking-enabled" class="wikivault-setting-input" />
								<label for="wikivault-setting-thinking-enabled" class="wikivault-setting-label">사용</label>
								<p class="wikivault-setting-description">문맥 파악 능력을 개선합니다 (0으로 설정 시 자동)</p>
							</div>
							<div class="wikivault-settings-option">
								<div class="wikivault-temperature-control">
									<input type="range" id="wikivault-setting-thinking-slider" class="wikivault-setting-input" min="0" max="24576" step="1" value="1024" disabled>
									<span id="wikivault-setting-thinking-value" class="wikivault-temperature-value">1024</span>
								</div>
							</div>
							<p class="wikivault-setting-warning"><span class="warning-icon">&#9889;</span>이 옵션을 켜면 성능이 느려집니다</p>
						</div>
					</div>
					<div class="wikivault-settings-item">
						<div class="wikivault-settings-label-wrapper">
							<label class="wikivault-settings-label">Temperature</label>
						</div>
						<div class="wikivault-settings-control-group">
							<div class="wikivault-settings-option">
								<input type="checkbox" id="wikivault-setting-temperature-auto" class="wikivault-setting-input" checked />
								<label for="wikivault-setting-temperature-auto" class="wikivault-setting-label">자동</label>
								<p class="wikivault-setting-description">의역의 정도를 설정합니다</p>
								<div class="wikivault-temperature-control">
									<input type="range" id="wikivault-setting-temperature-slider" class="wikivault-setting-input" min="0.0" max="2.0" step="0.1" value="0.7" disabled>
									<span id="wikivault-setting-temperature-value" class="wikivault-temperature-value">0.7</span>
								</div>
								<p class="wikivault-setting-warning"><span class="warning-icon">&#9889;</span>값이 높으면(1 초과 시) 오역 위험이 있습니다</p>
							</div>
						</div>
					</div>
				</div>
			</div>
			<div class="wikivault-settings-section">
				<p class="wikivault-settings-title">일반 설정</p>
				<div class="wikivault-settings-item">
					<label for="wikivault-attach-translation-template" class="wikivault-checkbox-label">
						<input type="checkbox" id="wikivault-attach-translation-template" class="wikivault-checkbox">
						토론 문서에 번역된 문서 틀 부착
					</label>
				</div>
			</div>
			<button id="wikivault-setting-reset-defaults" class="wikivault-button-primary">기본값으로 초기화</button>
			<p class="wikivault-settings-note">위 설정은 현재의 웹 브라우저에 저장됩니다.</p>
		</div>
	`);

	const closeButton = $('<div class="wikivault-modal-close"></div>')
		.html('<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>')
		.css({
			'position': 'absolute',
			'top': '10px',
			'right': '10px',
			'cursor': 'pointer',
			'padding': '4px',
			'border-radius': '4px',
			'transition': 'background-color 0.2s'
		})
		.hover(
			function() { $(this)[0].style.setProperty('background-color', 'var(--background-color-neutral-subtle, #f8f9fa)'); },
			function() { $(this).css('background-color', 'transparent'); }
		)
		.on('click', function() {
			modal.remove();
			overlay.remove();
		});

	const overlay = $('<div class="wikivault-modal-overlay"></div>')
		.css({
			'position': 'fixed',
			'top': '0',
			'left': '0',
			'right': '0',
			'bottom': '0',
			'background': 'rgba(0,0,0,0.5)',
			'z-index': '1003'
		});
		// Clicking the overlay intentionally does not close the modal

	modal.append(content, closeButton);
	$('body').append(overlay, modal);
	setupSettingsHandlers();
};

const showInfoModal = () => {
	const modal = $('<div class="wikivault-modal wikivault-info-modal"></div>')
		.css({
			'position': 'fixed',
			'top': '50%',
			'left': '50%',
			'transform': 'translate(-50%, -50%)',
			'background': 'var(--background-color-base, #fff)',
			'padding': '20px',
			'border-radius': '8px',
			'box-shadow': '0 2px 10px rgba(0,0,0,0.1)',
			'z-index': '1004',
			'max-width': '500px',
			'width': '90%',
			'display': 'block'
		});

	const content = $(`
		<div id="wikivault-info-area" class="wikivault-info-container">
			<p class="wikivault-info-title">WikiVault 정보</p>
			<div class="wikivault-info-content">
				<p class="wikivault-info-text">WikiVault는 위키백과에 유용한 기능을 제공하는 AI 기반 도구입니다.</p>
				<p class="wikivault-info-text2"><b>단축키</b>:<br>Ctrl + Alt(Option) + A: 모달 창 토글<br>Ctrl + Alt(Option) + M: 빠른 실행 도구 토글</p>
				<p class="wikivault-info-update-date">기능 업데이트 날짜: <span id="wikivault-last-modified"></span></p>
			</div>
		</div>
	`);

	const closeButton = $('<div class="wikivault-modal-close"></div>')
		.html('<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>')
		.css({
			'position': 'absolute',
			'top': '10px',
			'right': '10px',
			'cursor': 'pointer',
			'padding': '4px',
			'border-radius': '4px',
			'transition': 'background-color 0.2s'
		})
		.hover(
			function() { $(this)[0].style.setProperty('background-color', 'var(--background-color-neutral-subtle, #f8f9fa)'); },
			function() { $(this).css('background-color', 'transparent'); }
		)
		.on('click', function() {
			modal.remove();
			overlay.remove();
		});

	const overlay = $('<div class="wikivault-modal-overlay"></div>')
		.css({
			'position': 'fixed',
			'top': '0',
			'left': '0',
			'right': '0',
			'bottom': '0',
			'background': 'rgba(0,0,0,0.5)',
			'z-index': '1003'
		});
		// Clicking the overlay intentionally does not close the modal

	modal.append(content, closeButton);
	$('body').append(overlay, modal);

	// Update last modified date display
	const lastModified = localStorage.getItem('wikivault_last_modified');
	if (lastModified) {
		const date = new Date(parseInt(lastModified));
		$('#wikivault-last-modified').text(date.toLocaleString('ko-KR', {
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			hour12: false
		}));
	}
};

//#endregion


//#region 99. Bootstrap — App startup (must be last)

wikiVaultInit();

//#endregion
