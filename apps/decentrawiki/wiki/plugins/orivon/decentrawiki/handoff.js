/*\
title: $:/plugins/orivon/decentrawiki/handoff.js
type: application/javascript
module-type: library

Hands this published wiki to the DecentraWiki editor: the editor window this
page opens asks for the wiki with a "ready" message, and gets it back with
postMessage. A copy also rides in the editor address when it is small enough,
for a browser that keeps no opener link between the two pages.

\*/

"use strict";

var PROTOCOL = "decentrawiki-handoff";
var VERSION = 1;
var STORE_SELECTOR = "script.tiddlywiki-tiddler-store";
var EDITOR_PATH = "#/receive/";
var EDITOR_NAME = "editor.decentrawiki.eth";
var GATEWAY_EDITOR = "https://editor.decentrawiki.eth.limo/";
// Larger copies go by postMessage only: a URL of more than about 2 MB is refused outright.
var MAX_INLINE_CHARS = 700000;
var LISTEN_MS = 120000;

/** The tiddlers exactly as this page was published: its store areas, never the live wiki a reader may have changed. */
function publishedTiddlers(doc) {
	var tiddlers = [];
	var stores = doc.querySelectorAll(STORE_SELECTOR);
	for(var s = 0; s < stores.length; s++) {
		var parsed = JSON.parse(stores[s].textContent);
		for(var t = 0; t < parsed.length; t++) {
			if(parsed[t] && typeof parsed[t].title === "string") {
				tiddlers.push(parsed[t]);
			}
		}
	}
	return tiddlers;
}

/** Where the editor is: the configured address, else the one that matches how this page was reached. */
function editorAddress(wiki, location) {
	var configured = wiki.getTiddlerText("$:/config/DecentraWiki/EditorURL","").trim();
	if(configured) {
		return configured;
	}
	var host = location.hostname;
	var gateway = /\.eth\.(limo|link)$/.exec(host);
	if(gateway) {
		return "https://editor.decentrawiki.eth." + gateway[1] + "/";
	}
	// A browser that opens .eth names itself: the editor's own name, over the scheme this page came by.
	if(/\.eth$/.test(host) || /\.orivon$/.test(host)) {
		return (location.protocol === "http:" ? "http:" : "https:") + "//" + EDITOR_NAME + "/";
	}
	return GATEWAY_EDITOR;
}

function base64url(bytes) {
	var binary = "";
	for(var i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode.apply(null,bytes.subarray(i,i + 0x8000));
	}
	return btoa(binary).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
}

/** The payload, deflated and base64url-encoded, or null where the browser cannot compress. */
function inlineCopy(payload) {
	if(typeof CompressionStream === "undefined") {
		return Promise.resolve(null);
	}
	var stream = new Blob([JSON.stringify(payload)]).stream().pipeThrough(new CompressionStream("deflate-raw"));
	return new Response(stream).arrayBuffer().then(function(buffer) {
		return base64url(new Uint8Array(buffer));
	});
}

function randomNonce() {
	var bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return base64url(bytes);
}

function sourceOf(wiki, location) {
	return {
		url: location.href.split("#")[0],
		origin: location.origin,
		title: wiki.getTiddlerText("$:/SiteTitle","")
	};
}

/**
 * Opens the editor and hands it this wiki. `focus` names a tiddler to open
 * there, `edit` whether to open it for editing. Resolves with the opened
 * window, or null when the browser refused to open one.
 */
exports.openEditor = function(wiki, options) {
	options = options || {};
	var payload = {
		format: PROTOCOL,
		version: VERSION,
		source: sourceOf(wiki,window.location),
		focus: options.focus ? {title: options.focus, edit: !!options.edit} : null,
		tiddlers: publishedTiddlers(document)
	};
	var nonce = randomNonce();
	var base = editorAddress(wiki,window.location).replace(/#.*$/,"");
	return inlineCopy(payload).then(function(inline) {
		var address = base + EDITOR_PATH + nonce;
		var inlined = inline !== null && inline.length <= MAX_INLINE_CHARS;
		if(inlined) {
			address += "/" + inline;
		}
		var win;
		var onMessage = function(event) {
			var data = event.data;
			if(event.source !== win || !data || data.protocol !== PROTOCOL || data.nonce !== nonce) {
				return;
			}
			if(data.type === "ready") {
				win.postMessage({protocol: PROTOCOL, type: "wiki", nonce: nonce, payload: payload},event.origin);
			} else if(data.type === "received") {
				window.removeEventListener("message",onMessage);
			}
		};
		window.addEventListener("message",onMessage);
		setTimeout(function() {
			window.removeEventListener("message",onMessage);
		},LISTEN_MS);
		win = window.open(address,"_blank");
		if(!win) {
			window.removeEventListener("message",onMessage);
		}
		return {window: win || null, inline: inlined};
	});
};

/** The wiki as a JSON file of tiddlers, which the editor's "Import a file" reads. */
exports.downloadCopy = function(wiki) {
	var title = wiki.getTiddlerText("$:/SiteTitle","wiki").replace(/[^a-zA-Z0-9 _-]+/g,"").trim() || "wiki";
	var blob = new Blob([JSON.stringify(publishedTiddlers(document))],{type: "application/json"});
	var link = document.createElement("a");
	link.href = URL.createObjectURL(blob);
	link.download = title + ".decentrawiki.json";
	document.body.appendChild(link);
	link.click();
	setTimeout(function() {
		URL.revokeObjectURL(link.href);
		link.remove();
	},1000);
};

exports.publishedTiddlers = publishedTiddlers;
exports.editorAddress = editorAddress;
exports.PROTOCOL = PROTOCOL;
