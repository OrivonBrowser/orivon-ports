/*\
title: $:/core/modules/widgets/edit-text.js
type: application/javascript
module-type: widget

The edit-text widget of the editing frame. TiddlyWiki's own toolbar engine
writes into an iframe it makes, which a frame sandboxed without
allow-same-origin may not touch, so the editor would not start; the frame's
engine (engine.js) edits a textarea in the page instead.

\*/

"use strict";

var editTextWidgetFactory = require("$:/core/modules/editor/factory.js").editTextWidgetFactory,
	PageEngine = require("$:/plugins/orivon/decentrawiki-frame/engine.js").PageEngine,
	SimpleEngine = require("$:/core/modules/editor/engines/simple.js").SimpleEngine;

var EditTextWidget = editTextWidgetFactory(PageEngine,SimpleEngine);

// A key typed in the page reaches the keyboard widgets above the editor itself; a copy would reach them twice
EditTextWidget.prototype.propogateKeydownEvent = function() {
	return false;
};

exports["edit-text"] = EditTextWidget;
