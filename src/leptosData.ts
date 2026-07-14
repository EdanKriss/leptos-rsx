// Leptos-specific attribute namespaces and special attributes offered inside
// view! tags, with documentation shown in completion details and hovers.

export interface LeptosAttrStem {
    /** What the user sees and what gets inserted (trailing `:` retriggers suggest). */
    label: string;
    doc: string;
    /** Offered on component tags too (not just HTML elements)? */
    onComponents: boolean;
}

export const LEPTOS_STEMS: LeptosAttrStem[] = [
    {
        label: "on:",
        doc: "Attach a DOM event listener: `on:click=move |ev| { … }`.",
        onComponents: true,
    },
    {
        label: "class:",
        doc: "Toggle a single class reactively: `class:is-active=move || cond()`.",
        onComponents: false,
    },
    {
        label: "style:",
        doc: "Set a single CSS property reactively: `style:background-color=move || color()`.",
        onComponents: false,
    },
    {
        label: "prop:",
        doc: "Set a DOM *property* (not attribute): `prop:value=move || text()`.",
        onComponents: false,
    },
    {
        label: "attr:",
        doc: "Set an attribute explicitly, or spread attributes onto a component: `attr:data-id=id`.",
        onComponents: true,
    },
    {
        label: "bind:",
        doc: "Two-way binding for form fields: `bind:value=signal`, `bind:checked=signal`, `bind:group=signal`.",
        onComponents: false,
    },
    {
        label: "use:",
        doc: "Apply a directive function to this element: `use:my_directive` or `use:my_directive=param`.",
        onComponents: true,
    },
];

export const NODE_REF_DOC =
    "Bind a `NodeRef` to this element: `node_ref=input_ref` where `let input_ref = NodeRef::<html::Input>::new();`.";

/** DOM events that `bind:` supports as attribute names after the colon. */
export const BIND_TARGETS = ["value", "checked", "group"];
