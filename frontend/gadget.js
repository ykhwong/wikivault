$(document).ready(function() {
    if ($("#wikivault-floating-button").length) return;

    const WIKI_VAULT = {
        MAIN_URI: 'https://tedbot.toolforge.org',
        JS_CONTENT_API: '/api/get-js-content',
        INIT_API: '/api/init',
        IS_DEMO: true,
        STORAGE_KEYS: {
            LAST_MODIFIED: 'wikivault_last_modified',
            CACHED_CODE: 'wikivault_cached_code',
            BUTTON_POSITION: 'wikivault_button_position'
        }
    };

    const FLOATING_BUTTON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none">' +
        '<circle cx="12" cy="12" r="10" stroke="var(--background-color-progressive-subtle, white)" stroke-width="1.5" fill="none"></circle>' +
        '<rect x="11" y="9" width="2" height="10" transform="rotate(55 12 12)" fill="var(--background-color-progressive-subtle, white)"></rect>' +
        '<path d="M11.5 4.5h1.5v1.5h-1.5zM14.5 6h1.5v1.5h-1.5zM12.5 7.5h1.5v1.5h-1.5zM9.5 6h1.5v1.5h-1.5z" fill="var(--background-color-progressive-subtle, white)"></path>' +
        '</svg>';

    const BUTTON_STYLES = {
        position: 'fixed',
        right: '20px',
        top: '50%',
        transform: 'translateY(-50%)',
        width: '50px',
        height: '50px',
        'background-color': '#b0c4de',
        color: 'white',
        display: 'flex',
        'justify-content': 'center',
        'align-items': 'center',
        'border-radius': '50%',
        cursor: 'not-allowed',
        opacity: '1.0',
        'box-shadow': '0 2px 3px rgba(0,0,0,0.1)',
        'z-index': '1000',
        'touch-action': 'none'
    };

    function createFloatingButton() {
        const button = $("<div>", {
            id: "wikivault-floating-button",
            html: FLOATING_BUTTON_SVG
        }).css(BUTTON_STYLES).appendTo('body');

        // Load and sanitize saved position
        const savedPosition = localStorage.getItem(WIKI_VAULT.STORAGE_KEYS.BUTTON_POSITION);
        if (savedPosition) {
            try {
                const pos = JSON.parse(savedPosition);
                const viewportWidth = $(window).width();
                const viewportHeight = $(window).height();
                const buttonWidth = 50;
                const buttonHeight = 50;

                const safeLeft = Math.max(0, Math.min(pos.left, viewportWidth - buttonWidth));
                const safeTop = Math.max(0, Math.min(pos.top, viewportHeight - buttonHeight));

                button.css({
                    position: 'fixed',
                    left: safeLeft + 'px',
                    top: safeTop + 'px',
                    right: '',
                    transform: ''
                });

                if (safeLeft !== pos.left || safeTop !== pos.top) {
                    localStorage.setItem(WIKI_VAULT.STORAGE_KEYS.BUTTON_POSITION, JSON.stringify({
                        left: safeLeft,
                        top: safeTop
                    }));
                }
            } catch (e) {
                console.error("WikiVault: Failed to parse saved button position:", e);
                localStorage.removeItem(WIKI_VAULT.STORAGE_KEYS.BUTTON_POSITION);
            }
        }

        // Make the button draggable
        var isDragging = false;
        var offsetX, offsetY;
        var startX, startY;
        var DRAG_THRESHOLD = 5;

        function startDrag(e) {
            if (e.button === 2) return;
            isDragging = false;
            const event = e.originalEvent.touches ? e.originalEvent.touches[0] : e;
            const buttonRect = button[0].getBoundingClientRect();
            offsetX = event.clientX - buttonRect.left;
            offsetY = event.clientY - buttonRect.top;
            startX = event.clientX;
            startY = event.clientY;
            $('body').css('user-select', 'none');
            button.data('original-cursor', button.css('cursor'));
            button.css('cursor', 'grabbing');
            e.preventDefault();
        }

        function moveDrag(e) {
            if (!startX || !startY) return;

            const event = e.originalEvent.touches ? e.originalEvent.touches[0] : e;
            const dx = event.clientX - startX;
            const dy = event.clientY - startY;
            const distance = Math.sqrt(dx * dx + dy * dy);

            if (!isDragging && distance > DRAG_THRESHOLD) {
                isDragging = true;
                button.data('dragging', true);
            }

            if (!isDragging) return;

            const viewportWidth = $(window).width();
            const viewportHeight = $(window).height();
            const buttonWidth = button.outerWidth();
            const buttonHeight = button.outerHeight();

            var newLeft = event.clientX - offsetX;
            var newTop = event.clientY - offsetY;

            newLeft = Math.max(0, Math.min(newLeft, viewportWidth - buttonWidth));
            newTop = Math.max(0, Math.min(newTop, viewportHeight - buttonHeight));

            button.css({
                position: 'fixed',
                left: newLeft + 'px',
                top: newTop + 'px',
                right: 'auto',
                transform: 'none'
            });

            e.preventDefault();
        }

        function endDrag() {
            if (!isDragging) {
                // No drag, just a click
            }

            isDragging = false;
            button.data('dragging', false);
            startX = null;
            startY = null;

            const pos = {
                left: parseInt(button.css('left')),
                top: parseInt(button.css('top'))
            };
            localStorage.setItem(WIKI_VAULT.STORAGE_KEYS.BUTTON_POSITION, JSON.stringify(pos));

            $('body').css('user-select', '');
            button.css('cursor', button.data('original-cursor'));
        }

        button.on('mousedown touchstart', startDrag);
        $(document).on('mousemove touchmove', moveDrag);
        $(document).on('mouseup touchend', endDrag);

        // Adjust on resize
        $(window).on('resize', function() {
            const savedPosition = localStorage.getItem(WIKI_VAULT.STORAGE_KEYS.BUTTON_POSITION);
            if (savedPosition) {
                try {
                    const pos = JSON.parse(savedPosition);
                    const viewportWidth = $(window).width();
                    const viewportHeight = $(window).height();
                    const buttonWidth = button.outerWidth();
                    const buttonHeight = button.outerHeight();

                    const newLeft = Math.max(0, Math.min(pos.left, viewportWidth - buttonWidth));
                    const newTop = Math.max(0, Math.min(pos.top, viewportHeight - buttonHeight));

                    button.css({
                        left: newLeft + 'px',
                        top: newTop + 'px',
                        right: '',
                        transform: ''
                    });

                    if (newLeft !== pos.left || newTop !== pos.top) {
                        localStorage.setItem(WIKI_VAULT.STORAGE_KEYS.BUTTON_POSITION,
                            JSON.stringify({ left: newLeft, top: newTop }));
                    }
                } catch (e) {
                    console.error("WikiVault: Failed to handle resize:", e);
                }
            }
        });

        window.dispatchEvent(new Event('resize'));
    }

    function getWikiVaultUri(api) {
        return WIKI_VAULT.MAIN_URI + api;
    }

    function decodeResponse(response) {
        return response.split("").map(function(char) {
            return String.fromCharCode(char.charCodeAt(0) - 3);
        }).join("");
    }

    function executeCode(code) {
        try {
            const decodedResponse = decodeResponse(code);
            new Function(decodedResponse)();
        } catch (e) {
            console.error("Script Execution Error:", e);
        }
    }

    function loadAndExecuteScript() {
        if (WIKI_VAULT.IS_DEMO) return;

        $.ajax({
            url: getWikiVaultUri(WIKI_VAULT.INIT_API),
            type: 'GET',
            success: function(initResponse) {
                const serverLastModified = Math.floor(initResponse.lastModified);
                const cachedLastModified = localStorage.getItem(WIKI_VAULT.STORAGE_KEYS.LAST_MODIFIED);
                const cachedCode = localStorage.getItem(WIKI_VAULT.STORAGE_KEYS.CACHED_CODE);

                if (cachedCode && cachedLastModified && serverLastModified === Number(cachedLastModified)) {
                    executeCode(cachedCode);
                    return;
                }

                $.ajax({
                    url: getWikiVaultUri(WIKI_VAULT.JS_CONTENT_API),
                    type: 'GET',
                    dataType: 'text',
                    success: function(response) {
                        localStorage.setItem(WIKI_VAULT.STORAGE_KEYS.CACHED_CODE, response);
                        localStorage.setItem(WIKI_VAULT.STORAGE_KEYS.LAST_MODIFIED, serverLastModified);
                        executeCode(response);
                    },
                    error: function(xhr, status, error) {
                        console.error("Script Fetch Failed:", status, error);
                        if (cachedCode) {
                            executeCode(cachedCode);
                        }
                    }
                });
            },
            error: function(xhr, status, error) {
                console.error("Init Request Failed:", status, error);
                const cachedCode = localStorage.getItem(WIKI_VAULT.STORAGE_KEYS.CACHED_CODE);
                if (cachedCode) {
                    executeCode(cachedCode);
                }
            }
        });
    }

    createFloatingButton();
    loadAndExecuteScript();
});

