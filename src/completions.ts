import * as vscode from "vscode";
import { getDefaultHTMLDataProvider } from "vscode-html-languageservice";
import type { IAttributeData } from "vscode-html-languageservice";
import { rsxContextAt } from "./rsxContext.ts";
import { htmlDoc } from "./htmlDoc.ts";
import { LEPTOS_STEMS, NODE_REF_DOC, BIND_TARGETS } from "./leptosData.ts";

const RETRIGGER_SUGGEST: vscode.Command = {
    command: "editor.action.triggerSuggest",
    title: "Suggest",
};

export class RsxCompletionProvider implements vscode.CompletionItemProvider {
    private readonly data = getDefaultHTMLDataProvider();
    private globalAttrNames: Set<string> | undefined;

    provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position,
    ): vscode.CompletionItem[] | undefined {
        const offset = document.offsetAt(position);
        const ctx = rsxContextAt(document.getText(), offset);

        const replaceRange = (partial: string) =>
            new vscode.Range(document.positionAt(offset - partial.length), position);

        switch (ctx.kind) {
            case "tag-name":
                return this.tagNameItems(ctx.partial, ctx.closing, ctx.parentTag, replaceRange(ctx.partial));
            case "attribute-name":
                return this.attributeNameItems(ctx.tag, ctx.component, ctx.partial, replaceRange(ctx.partial));
            case "attribute-value":
                if (ctx.component || ctx.attribute === null) return undefined;
                return this.attributeValueItems(ctx.tag, ctx.attribute, ctx.quoted, replaceRange(ctx.partial));
            default:
                return undefined;
        }
    }

    private tagNameItems(
        _partial: string,
        closing: boolean,
        parentTag: string | null,
        range: vscode.Range,
    ): vscode.CompletionItem[] {
        const items: vscode.CompletionItem[] = [];

        if (closing && parentTag) {
            const item = new vscode.CompletionItem(parentTag, vscode.CompletionItemKind.Property);
            item.insertText = `${parentTag}>`;
            item.detail = "close enclosing tag";
            item.range = range;
            item.sortText = "0";
            items.push(item);
        }

        for (const tag of this.data.provideTags()) {
            if (closing && tag.name === parentTag) continue;
            const item = new vscode.CompletionItem(tag.name, vscode.CompletionItemKind.Property);
            item.documentation = htmlDoc(tag);
            item.range = range;
            item.sortText = `1${tag.name}`;
            if (closing) item.insertText = `${tag.name}>`;
            items.push(item);
        }
        return items;
    }

    private attributeNameItems(
        tag: string,
        component: boolean,
        partial: string,
        range: vscode.Range,
    ): vscode.CompletionItem[] {
        const items: vscode.CompletionItem[] = [];
        const attributes = this.data.provideAttributes(component ? "div" : tag);

        // `bind:` targets once the user has typed the stem.
        if (partial.startsWith("bind:") && !component) {
            return BIND_TARGETS.map((name) => {
                const item = new vscode.CompletionItem(`bind:${name}`, vscode.CompletionItemKind.Property);
                item.range = range;
                item.insertText = new vscode.SnippetString(`bind:${name}=$0`);
                return item;
            });
        }

        // DOM events in Leptos `on:` form, derived from the HTML data's on* attributes.
        for (const attr of attributes) {
            if (!attr.name.startsWith("on") || attr.name.startsWith("on:")) continue;
            const event = attr.name.slice(2);
            const item = new vscode.CompletionItem(`on:${event}`, vscode.CompletionItemKind.Event);
            item.documentation = htmlDoc(attr);
            item.range = range;
            item.sortText = `4on:${event}`;
            item.insertText = new vscode.SnippetString(`on:${event}=$0`);
            items.push(item);
        }

        // Leptos namespace stems and node_ref.
        for (const stem of LEPTOS_STEMS) {
            if (component && !stem.onComponents) continue;
            if (stem.label === "on:") continue; // expanded above
            const item = new vscode.CompletionItem(stem.label, vscode.CompletionItemKind.Keyword);
            item.documentation = new vscode.MarkdownString(stem.doc);
            item.range = range;
            item.sortText = `0${stem.label}`;
            item.command = RETRIGGER_SUGGEST;
            items.push(item);
        }
        if (!component) {
            const nodeRef = new vscode.CompletionItem("node_ref", vscode.CompletionItemKind.Keyword);
            nodeRef.documentation = new vscode.MarkdownString(NODE_REF_DOC);
            nodeRef.range = range;
            nodeRef.sortText = "0node_ref";
            nodeRef.insertText = new vscode.SnippetString("node_ref=$0");
            items.push(nodeRef);
        }

        if (component) return items;

        // Plain HTML attributes, element-specific ones ranked above global/aria.
        const globals = this.globalAttributeNames();
        for (const attr of attributes) {
            if (attr.name.startsWith("on")) continue; // covered by on: events
            const item = new vscode.CompletionItem(attr.name, vscode.CompletionItemKind.Property);
            item.documentation = htmlDoc(attr);
            item.range = range;
            item.sortText = attr.name.startsWith("aria-")
                ? `3${attr.name}`
                : globals.has(attr.name)
                    ? `2${attr.name}`
                    : `1${attr.name}`;
            if (!this.isBoolean(attr)) {
                item.insertText = new vscode.SnippetString(`${attr.name}="$1"`);
                if (attr.values?.length || attr.valueSet) item.command = RETRIGGER_SUGGEST;
            }
            items.push(item);
        }
        return items;
    }

    private attributeValueItems(
        tag: string,
        attribute: string,
        quoted: boolean,
        range: vscode.Range,
    ): vscode.CompletionItem[] | undefined {
        const values = this.data.provideValues(tag, attribute);
        if (!values.length) return undefined;
        return values.map((v) => {
            const item = new vscode.CompletionItem(v.name, vscode.CompletionItemKind.EnumMember);
            item.documentation = htmlDoc(v);
            if (quoted) {
                item.range = range;
            } else {
                item.insertText = `"${v.name}"`;
            }
            return item;
        });
    }

    private isBoolean(attr: IAttributeData): boolean {
        return attr.valueSet === "v";
    }

    private globalAttributeNames(): Set<string> {
        // Attributes offered for a tag the data set doesn't know = the global set.
        this.globalAttrNames ??= new Set(
            this.data.provideAttributes("not-a-real-tag").map((a) => a.name),
        );
        return this.globalAttrNames;
    }
}
