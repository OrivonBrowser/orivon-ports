/*\
title: $:/plugins/orivon/decentrawiki/viewer.js
type: application/javascript
module-type: startup

In a published wiki every way of editing opens the DecentraWiki editor: the
page's pen, a tiddler's edit button, a double-click and a keyboard shortcut.
In the editor's own editing frame the mode tiddler says "edit", and nothing
here runs.

\*/

"use strict";

exports.name = "decentrawiki-viewer";
exports.platforms = ["browser"];
exports.after = ["rootwidget"];
exports.synchronous = true;

var MODE = "$:/config/DecentraWiki/Mode";
var NOTICE_BLOCKED = "$:/plugins/orivon/decentrawiki/ui/Blocked";
var NOTICE_FAILED = "$:/plugins/orivon/decentrawiki/ui/Failed";

exports.startup = function() {
	var handoff = require("$:/plugins/orivon/decentrawiki/handoff.js");
	var editor = handoff.editorAddress($tw.wiki,window.location);
	// For links a wiki writes to the editor and to DecentraWiki's own guide, in either mode. $:/temp is never saved.
	$tw.wiki.addTiddler({title: "$:/temp/DecentraWiki/EditorURL", text: editor});
	$tw.wiki.addTiddler({title: "$:/temp/DecentraWiki/HomeURL", text: editor.replace("//editor.","//")});
	if($tw.wiki.getTiddlerText(MODE,"").trim() !== "published") {
		return;
	}
	var opening = false;
	function open(focus,edit) {
		if(opening) {
			return;
		}
		opening = true;
		handoff.openEditor($tw.wiki,{focus: focus, edit: edit}).then(function(result) {
			opening = false;
			if(!result.window) {
				$tw.notifier.display(NOTICE_BLOCKED);
			}
		},function() {
			opening = false;
			$tw.notifier.display(NOTICE_FAILED);
		});
	}
	$tw.hooks.addHook("th-editing-tiddler",function(event) {
		var title = event.param || event.tiddlerTitle;
		open(title || null,!!title);
		return false;
	});
	$tw.hooks.addHook("th-new-tiddler",function(event) {
		open(null,false);
		return event;
	});
	$tw.rootWidget.addEventListener("tm-decentrawiki-edit",function(event) {
		open(event.param || null,!!event.param);
		return false;
	});
	$tw.rootWidget.addEventListener("tm-decentrawiki-download",function() {
		handoff.downloadCopy($tw.wiki);
		return false;
	});
};
