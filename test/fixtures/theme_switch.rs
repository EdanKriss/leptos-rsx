use leptos::prelude::*;

#[component]
pub fn ThemeSwitch() -> impl IntoView {
    let mode = RwSignal::new(ThemeMode::System);
    let modes = [ThemeMode::Light, ThemeMode::System, ThemeMode::Dark];

    view! {
        <div class="theme-switch" role="radiogroup" aria-label="Color theme">
            <span class="theme-switch__thumb"></span>
            {modes
                .into_iter()
                .map(|m| {
                    view! {
                        <button
                            class="theme-switch__option"
                            class:is-active=move || mode.get() == m
                            type="button"
                            role="radio"
                            aria-checked=move || (mode.get() == m).to_string()
                            aria-label=m.label()
                            title=m.label()
                            on:click=move |_| mode.set(m)
                        >
                            {m.icon()}
                        </button>
                    }
                })
                .collect_view()}
        </div>
    }
}

#[component]
fn Torture(count: RwSignal<i32>) -> impl IntoView {
    let double = move || count.get() * 2;
    view! {
        // comments inside rsx stay comments
        <>
            <p style:color="red" prop:value=double attr:data-thing="x">
                "quoted text node" {double()} plain text
            </p>
            <input type="checkbox" bind:checked=count disabled />
            <Show when=move || count.get() != 0 fallback=|| view! { <span>"nested!"</span> }>
                <my_crate::widgets::Fancy on:click=move |_| {
                    let msg = format!("clicked {} times", count.get());
                    log::info!("{msg}");
                } />
            </Show>
        </>
    }
}
