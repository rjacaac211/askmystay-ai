/**
 * AskMyStay embed loader.
 *
 * One line on a host's guidebook or property microsite:
 *
 *   <script src="https://askmystay.example.com/widget.js"
 *           data-property="sunset-ridge-cabin"
 *           data-booking="BK-4471" async></script>
 *
 * It adds a launcher button and, on first open, an iframe pointing at
 * /embed/<property>. Everything the assistant does happens inside that frame.
 *
 * Why an iframe rather than rendering inline: this script runs on pages we do
 * not control. Inline markup would collide with the host's CSS in both
 * directions — their `button {}` rule restyling our send button, our reset
 * breaking their layout. A frame is a hard boundary for styles and scripts, and
 * the only cost is passing height across it.
 *
 * Deliberately dependency-free and in `static/`: it is served as-is, so a host
 * pastes a URL rather than adding a build step.
 */
(function () {
	'use strict';

	var script = document.currentScript;
	if (!script) return;

	var property = script.getAttribute('data-property');
	if (!property) {
		console.error('[askmystay] widget.js needs a data-property attribute.');
		return;
	}

	// Guard against a host including the snippet twice (a partial and a layout,
	// say) — otherwise they get two launchers stacked on each other.
	if (window.__askmystayWidget) return;
	window.__askmystayWidget = true;

	var booking = script.getAttribute('data-booking');
	var label = script.getAttribute('data-label') || 'Ask about your stay';
	// The script's own src is the source of truth for where the app lives, so a
	// host never has to configure an origin separately.
	var origin = new URL(script.src, window.location.href).origin;

	var frameUrl = origin + '/embed/' + encodeURIComponent(property);
	if (booking) frameUrl += '?booking=' + encodeURIComponent(booking);

	var open = false;
	var frame = null;

	var launcher = document.createElement('button');
	launcher.type = 'button';
	launcher.setAttribute('aria-label', label);
	launcher.textContent = '💬';
	style(launcher, {
		position: 'fixed',
		right: '20px',
		bottom: '20px',
		width: '56px',
		height: '56px',
		borderRadius: '999px',
		border: '0',
		background: '#2f6f4f',
		color: '#fff',
		fontSize: '24px',
		lineHeight: '56px',
		cursor: 'pointer',
		boxShadow: '0 6px 20px rgba(0,0,0,0.22)',
		// Above almost anything a host page is likely to stack.
		zIndex: '2147483000'
	});

	var panel = document.createElement('div');
	style(panel, {
		position: 'fixed',
		right: '20px',
		bottom: '88px',
		width: 'min(400px, calc(100vw - 40px))',
		height: 'min(560px, calc(100vh - 120px))',
		background: '#fff',
		borderRadius: '14px',
		overflow: 'hidden',
		boxShadow: '0 12px 40px rgba(0,0,0,0.25)',
		zIndex: '2147483000',
		display: 'none'
	});

	function style(el, props) {
		for (var key in props) el.style[key] = props[key];
	}

	function toggle() {
		open = !open;
		panel.style.display = open ? 'block' : 'none';
		launcher.textContent = open ? '✕' : '💬';

		// The frame is created on first open, not on page load: a host page should
		// not pay for the assistant until a guest actually wants it.
		if (open && !frame) {
			frame = document.createElement('iframe');
			frame.src = frameUrl;
			frame.title = label;
			style(frame, { width: '100%', height: '100%', border: '0', display: 'block' });
			panel.appendChild(frame);
		}
	}

	launcher.addEventListener('click', toggle);

	document.addEventListener('keydown', function (event) {
		if (event.key === 'Escape' && open) toggle();
	});

	function mount() {
		document.body.appendChild(panel);
		document.body.appendChild(launcher);
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', mount);
	} else {
		mount();
	}
})();
