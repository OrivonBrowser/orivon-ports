/*\
title: $:/plugins/orivon/decentrawiki-frame/engine.js
type: application/javascript
module-type: library

The engine behind the editor toolbar in the editing frame: TiddlyWiki's simple
engine, on a textarea in the page, with what the toolbar needs from the framed
engine it stands in for (edit-text.js): the text operation every toolbar button
sends, the toolbar's keyboard shortcuts, and files dropped or pasted into the
editor. The operations follow TiddlyWiki's framed engine (BSD 3-Clause, Jeremy
Ruston and the TiddlyWiki contributors).

\*/

"use strict";

var SimpleEngine = require("$:/core/modules/editor/engines/simple.js").SimpleEngine;

function PageEngine(options) {
	SimpleEngine.call(this,options);
	var listeners = [{name: "keydown",handlerObject: this,handlerMethod: "handleKeydownEvent"}];
	// The editor's dropzone ignores a drop or a paste aimed at a textarea; the widget stops one that
	// carries files and sends it on from the textarea's parent. Other drag events reach the dropzone as they are.
	if(this.widget.isFileDropEnabled) {
		listeners.push(
			{name: "drop",handlerObject: this.widget,handlerMethod: "handleDropEvent"},
			{name: "paste",handlerObject: this.widget,handlerMethod: "handlePasteEvent"}
		);
	}
	$tw.utils.addEventListeners(this.domNode,listeners);
}

PageEngine.prototype = Object.create(SimpleEngine.prototype);
PageEngine.prototype.constructor = PageEngine;

/*
Priority shortcuts first, then the toolbar's own
*/
PageEngine.prototype.handleKeydownEvent = function(event) {
	if($tw.keyboardManager.handleKeydownEvent(event,{onlyPriority: true})) {
		return true;
	}
	return this.widget.handleKeydownEvent(event);
};

/*
Create a structure representing a text operation on the current selection
*/
PageEngine.prototype.createTextOperation = function() {
	var operation = {
		text: this.domNode.value,
		selStart: this.domNode.selectionStart,
		selEnd: this.domNode.selectionEnd,
		cutStart: null,
		cutEnd: null,
		replacement: null,
		newSelStart: null,
		newSelEnd: null
	};
	operation.selection = operation.text.substring(operation.selStart,operation.selEnd);
	return operation;
};

/*
Execute a text operation, as a typed edit where the browser can make one, so that undo takes it back
*/
PageEngine.prototype.executeTextOperation = function(operation) {
	var newText = operation.text;
	if(operation.replacement !== null) {
		newText = operation.text.substring(0,operation.cutStart) + operation.replacement + operation.text.substring(operation.cutEnd);
		var doc = this.domNode.ownerDocument;
		this.domNode.focus();
		this.domNode.setSelectionRange(operation.cutStart,operation.cutEnd);
		if(!$tw.browser.isFirefox && doc.queryCommandSupported("insertText") && doc.queryCommandSupported("delete")) {
			doc.execCommand(operation.replacement === "" ? "delete" : "insertText",false,operation.replacement);
		}
		// A browser may refuse the command without saying so: the textarea must still show what is saved
		if(this.domNode.value !== newText) {
			this.domNode.value = newText;
		}
		this.domNode.focus();
		this.domNode.setSelectionRange(operation.newSelStart,operation.newSelEnd);
	}
	this.domNode.focus();
	return newText;
};

exports.PageEngine = PageEngine;
