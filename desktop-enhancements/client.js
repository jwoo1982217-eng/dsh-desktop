window.__ModuleLoader__.load({id:'dsh-desktop-enhancements',factory:(require)=>{
const module={exports:{}};const exports=module.exports;
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var stdin_exports = {};
__export(stdin_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(stdin_exports);
var import_react = __toESM(require("react"));
const inject = ["slots"];
function Frame({ sessionId, plugins = false }) {
  const src = "/desktop-enhancements" + (sessionId ? "?sessionId=" + encodeURIComponent(sessionId) : "") + (plugins ? "#plugins" : "");
  return /* @__PURE__ */ import_react.default.createElement("iframe", { title: plugins ? "\u63D2\u4EF6\u66F4\u65B0" : "\u8017\u65F6\u4E0E\u7F13\u5B58\u7EDF\u8BA1", src, style: { display: "block", width: "100%", height: plugins ? "min(76dvh,850px)" : "100%", minHeight: 400, border: 0 } });
}
function apply(ctx) {
  ctx.slots.inject("conversation.view", () => ctx.slots.register({ name: "conversation.view", id: "desktop-metrics", order: 20, label: () => "\u7EDF\u8BA1", inject: (sessionId) => ({ sessionId }) }, Frame));
  ctx.slots.inject("settings.section", () => ctx.slots.register({ name: "settings.section", id: "desktop-plugin-updates", label: "\u63D2\u4EF6\u66F4\u65B0", order: 38 }, () => /* @__PURE__ */ import_react.default.createElement(Frame, { plugins: true })));
}

return module.exports;}});
