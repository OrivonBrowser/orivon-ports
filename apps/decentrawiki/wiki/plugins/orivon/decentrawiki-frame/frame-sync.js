/*\
title: $:/plugins/orivon/decentrawiki-frame/frame-sync.js
type: application/javascript
module-type: startup

Inside the editor's sandboxed frame: sends every change of the wiki to the
editor page, which keeps it, and answers the editor's requests to open a
tiddler and to render the wiki as it will be published.

\*/

"use strict";

exports.name = "decentrawiki-frame";
exports.platforms = ["browser"];
exports.after = ["story"];
exports.synchronous = true;

var PROTOCOL = "decentrawiki-frame";
// What the editor keeps of a wiki: everything a person made, drafts included, never the page's passing state,
// what TiddlyWiki reports about this browser ($:/info/), or what the core file sets on every page it loads.
var NOT_KEPT = /^(?:\$:\/(?:state|temp|status|info)\/|\$:\/(?:StoryList|HistoryList|Import)$|\$:\/plugins\/orivon\/decentrawiki-frame(?:\/|$)|\$:\/config\/DecentraWiki\/Mode$|\$:\/DecentraWiki\/Lineage$|\$:\/config\/SaveWikiButton\/Template$)/;
// The frame's own tiddlers and a person's unfinished edits are not part of what is published.
var PUBLISH_FILTER = "-[prefix[$:/plugins/orivon/decentrawiki-frame]] -[[$:/config/DecentraWiki/Mode]] -[has[draft.of]] -[[$:/StoryList]] -[[$:/HistoryList]] -[prefix[$:/state/]] -[prefix[$:/status/]] -[prefix[$:/info/]] -[[$:/Import]]";
var PUBLISH_TEMPLATE = "$:/core/save/offline-external-js";

exports.kept = function(title) {
	return !NOT_KEPT.test(title);
};

exports.startup = function() {
	var bridge = $tw.decentrawikiFrame;
	if(!bridge) {
		return;
	}
	// The editor page keeps every change as it happens, so leaving never loses anything.
	window.onbeforeunload = null;
	$tw.wiki.addEventListener("change",function(changes) {
		var put = [], removed = [];
		$tw.utils.each(changes,function(change,title) {
			if(!exports.kept(title)) {
				return;
			}
			// Only real tiddlers: a plugin unpacking its shadows reports them as changes too, and they are not the person's.
			if($tw.wiki.tiddlerExists(title)) {
				put.push($tw.wiki.getTiddler(title).getFieldStrings());
			} else if(change.deleted) {
				removed.push(title);
			}
		});
		if(put.length || removed.length) {
			bridge.send({type: "changes", put: put, removed: removed});
		}
	});
	window.addEventListener("message",function(event) {
		var data = event.data;
		if(event.source !== window.parent || !data || data.protocol !== PROTOCOL) {
			return;
		}
		if(data.type === "open" && typeof data.title === "string") {
			openTiddler(data.title,!!data.edit);
		} else if(data.type === "render") {
			bridge.send(renderPublished(data.id,data.extra));
		}
	});
	if(bridge.open && typeof bridge.open.title === "string") {
		openTiddler(bridge.open.title,!!bridge.open.edit);
	} else {
		reopenDrafts();
	}
};

/** Unfinished edits from an earlier session come back open, so nothing a person was writing is hidden from them. */
function reopenDrafts() {
	var story = new $tw.Story({wiki: $tw.wiki});
	$tw.utils.each($tw.wiki.filterTiddlers("[has[draft.of]!sort[modified]]"),function(title) {
		story.addToStory(title,null,{openLinkFromOutsideRiver: "top"});
	});
}

function openTiddler(title,edit) {
	var story = new $tw.Story({wiki: $tw.wiki});
	var target = title;
	if(edit) {
		target = $tw.wiki.findDraft(title);
		if(!target) {
			target = $tw.wiki.generateDraftTitle(title);
			var existing = $tw.wiki.getTiddler(title);
			$tw.wiki.addTiddler(new $tw.Tiddler($tw.wiki.getCreationFields(),existing,{
				title: target,
				"draft.title": title,
				"draft.of": title
			},$tw.wiki.getModificationFields()));
		}
	}
	story.addToStory(target,null,{openLinkFromOutsideRiver: "top"});
	story.addToHistory(target);
}

/** The wiki as one HTML page that loads the shared TiddlyWiki core beside it. `extra` are tiddlers only the published copy carries. */
function renderPublished(id,extra) {
	var added = [];
	try {
		$tw.utils.each(Array.isArray(extra) ? extra : [],function(fields) {
			if(fields && typeof fields.title === "string" && !$tw.wiki.tiddlerExists(fields.title)) {
				$tw.wiki.addTiddler(new $tw.Tiddler(fields));
				added.push(fields.title);
			}
		});
		var html = $tw.wiki.renderTiddler("text/plain",PUBLISH_TEMPLATE,{variables: {publishFilter: PUBLISH_FILTER}});
		var icon = $tw.wiki.getTiddler("$:/favicon.ico");
		return {
			type: "rendered",
			id: id,
			html: html,
			favicon: icon ? {type: icon.fields.type || "", text: icon.fields.text || ""} : null
		};
	} catch(error) {
		return {type: "render-failed", id: id, message: String(error && error.message || error)};
	} finally {
		$tw.utils.each(added,function(title) {
			$tw.wiki.deleteTiddler(title);
		});
	}
}
