import {
	DynamicBorder,
	getMarkdownTheme,
	getSelectListTheme,
	type KeybindingsManager,
	type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Box, Container, Markdown, SelectList, Spacer, Text } from "@mariozechner/pi-tui";

export interface ControlPanelItem {
	value: string;
	label: string;
	description?: string;
	detailMarkdown: string;
}

export interface ControlPanelAction<Action extends string> {
	key: string;
	label: string;
	result: Action;
}

export interface ControlPanelOutcome<Action extends string> {
	action: Action | "close";
	selectedValue: string | null;
}

function formatResolvedKeys(keys: readonly string[]): string {
	const deduped = [...new Set(keys.filter(Boolean))];
	return deduped.join("/");
}

function renderKeyHint(theme: ExtensionContext["ui"]["theme"], keys: readonly string[], label: string): string {
	const resolved = formatResolvedKeys(keys);
	return `${theme.fg("dim", resolved)}${theme.fg("muted", ` ${label}`)}`;
}

function renderControlPanelFooter<Action extends string>(
	theme: ExtensionContext["ui"]["theme"],
	keybindings: KeybindingsManager,
	actions: ControlPanelAction<Action>[],
): string {
	const hints = [
		renderKeyHint(theme, [...keybindings.getKeys("tui.select.up"), ...keybindings.getKeys("tui.select.down")], "move"),
		renderKeyHint(theme, keybindings.getKeys("tui.select.confirm"), "select"),
		renderKeyHint(theme, keybindings.getKeys("tui.select.cancel"), "close"),
		...actions.map((action) => renderKeyHint(theme, [action.key], action.label)),
	];
	return hints.join(theme.fg("dim", "  ·  "));
}

export async function openControlPanel<Action extends string>(
	ctx: ExtensionContext,
	options: {
		title: string;
		subtitle?: string;
		items: ControlPanelItem[];
		selectedValue?: string | null;
		actions: ControlPanelAction<Action>[];
	},
): Promise<ControlPanelOutcome<Action> | null> {
	if (!ctx.ui.custom) return null;
	const fallbackItem: ControlPanelItem = {
		value: "empty",
		label: "Nothing to show",
		description: "no quest data",
		detailMarkdown: "# Nothing to show\n\nNo Quest data is available yet.",
	};
	const items = options.items.length > 0 ? options.items : [fallbackItem];
	const selectTheme = getSelectListTheme();
	const markdownTheme = getMarkdownTheme();
	return ctx.ui.custom<ControlPanelOutcome<Action>>((tui, theme, keybindings, done) => {
		const normalizedIndex = Math.max(
			0,
			items.findIndex((item) => item.value === options.selectedValue),
		);
		const footer = renderControlPanelFooter(theme, keybindings, options.actions);
		const selectList = new SelectList(items, Math.min(Math.max(items.length, 4), 10), selectTheme, {
			minPrimaryColumnWidth: 24,
			maxPrimaryColumnWidth: 56,
		});
		const detail = new Markdown(items[normalizedIndex]?.detailMarkdown ?? fallbackItem.detailMarkdown, 0, 0, markdownTheme, {
			color: (text: string) => theme.fg("text", text),
		});
		const detailBox = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		detailBox.addChild(detail);

		let selectedValue = items[normalizedIndex]?.value ?? items[0]?.value ?? null;
		const applySelection = (value: string | null) => {
			const selected = items.find((item) => item.value === value) ?? items[0] ?? fallbackItem;
			selectedValue = selected.value;
			detail.setText(selected.detailMarkdown);
			detail.invalidate();
			detailBox.invalidate();
		};

		selectList.onSelectionChange = (item) => {
			applySelection(item.value);
			tui.requestRender();
		};
		selectList.onSelect = (item) => {
			applySelection(item.value);
			tui.requestRender();
		};
		selectList.setSelectedIndex(normalizedIndex);
		applySelection(items[normalizedIndex]?.value ?? null);

		const container = new Container();
		container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
		container.addChild(new Text(theme.bold(theme.fg("accent", options.title)), 1, 0));
		if (options.subtitle) container.addChild(new Text(theme.fg("muted", options.subtitle), 1, 0));
		container.addChild(new Spacer(1));
		container.addChild(selectList);
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.bold("Detail"), 1, 0));
		container.addChild(detailBox);
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", footer), 1, 0));
		container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));

		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				if (keybindings.matches(data, "tui.select.cancel")) {
					done({ action: "close", selectedValue });
					return;
				}
				for (const action of options.actions) {
					if (data === action.key) {
						done({ action: action.result, selectedValue });
						return;
					}
				}
				selectList.handleInput(data);
				const selected = selectList.getSelectedItem();
				if (selected) applySelection(selected.value);
				tui.requestRender();
			},
		};
	});
}
