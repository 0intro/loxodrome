/* The "?" map (ShortcutsOverlay): the keys and pointer gestures that exist,
 * grouped by the surface that answers them. It documents, never defines: a row
 * is added here when the binding ships, and the key caps are catalog text so a
 * French keyboard reads its own key names (Échap, Suppr, Maj) and a French
 * pointer its own gestures (Molette, Glisser); the arrow glyphs are
 * locale-invariant. A cap containing "+" is one chord; several caps on a row
 * are alternatives or a range. Gesture rows name what the pointer does, since
 * a gesture has no key cap to print. */

export interface ShortcutRow {
	/** Key caps, each rendered as its own <kbd>. */
	keys: string[];
	text: string;
}

export interface ShortcutGroup {
	title: string;
	rows: ShortcutRow[];
}

export const shortcuts = {
	title: 'Shortcuts and gestures',
	groups: [
		{
			title: 'Anywhere',
			rows: [
				{ keys: ['?'], text: 'Open or close this list' },
				{ keys: ['Ctrl+K'], text: 'Open or close the search' },
				{ keys: ['Esc'], text: 'Close the topmost menu, dialog or surface' },
				{ keys: ['Ctrl+Z'], text: 'Undo a route edit' },
				{ keys: ['Ctrl+Shift+Z', 'Ctrl+Y'], text: 'Redo a route edit' },
				{ keys: ['Del'], text: 'Remove the selected route waypoint' },
			],
		},
		{
			title: 'Map (focused)',
			rows: [
				{ keys: ['←', '↑', '↓', '→'], text: 'Pan the map' },
				{ keys: ['+', '-'], text: 'Zoom in / out' },
			],
		},
		{
			title: 'Detail panel',
			rows: [{ keys: ['←', '→'], text: 'Previous / next NOTAM in the list' }],
		},
		{
			title: 'Navigation log and route profile',
			rows: [{ keys: ['←', '→'], text: 'Show the previous / next route' }],
		},
		{
			title: 'Altitude profile charts (chart focused)',
			rows: [
				{ keys: ['↑', '↓'], text: 'Pan the altitude window' },
				{ keys: ['PgUp', 'PgDn'], text: 'Pan by a whole window' },
				{ keys: ['+', '-'], text: 'Zoom the window' },
				{ keys: ['Home'], text: 'Fit the window to the stack' },
				{ keys: ['Enter'], text: 'Open the focused column' },
			],
		},
		{
			title: 'Route and trace vertical profiles (chart focused)',
			rows: [
				{ keys: ['←', '→'], text: 'Pan the distance window' },
				{ keys: ['↑', '↓'], text: 'Pan the altitude window' },
				{ keys: ['PgUp', 'PgDn'], text: 'Pan the altitude by a whole window' },
				{ keys: ['+', '-'], text: 'Zoom the distance window' },
				{ keys: ['Home'], text: 'Fit both windows' },
			],
		},
		{
			title: 'Route and trace vertical profiles (pointer)',
			rows: [
				{ keys: ['Wheel'], text: 'Zoom the distance window at the cursor' },
				{
					keys: ['Shift+Wheel'],
					text: 'Zoom the altitude window, as does the wheel over the altitude axis',
				},
				{ keys: ['Wheel ←→'], text: 'Pan the distance window (a trackpad two-finger swipe)' },
				{ keys: ['Drag'], text: 'Pan both windows; on the trace profile, seek the replay' },
				{ keys: ['Middle-drag'], text: 'Pan both windows from anywhere on the plot' },
				{ keys: ['Drag an axis'], text: 'Pan that axis alone' },
				{ keys: ['Two fingers'], text: 'Pinch to zoom, drag to pan' },
				{ keys: ['Right-click', 'Long press'], text: 'List the airspaces and NOTAMs here' },
			],
		},
		{
			title: 'Altitude profile charts (pointer)',
			rows: [
				{ keys: ['Wheel'], text: 'Zoom the altitude window about the ground' },
				{ keys: ['Drag', 'Middle-drag'], text: 'Pan the altitude window' },
				{ keys: ['Double-click'], text: 'Fit the window to the stack' },
			],
		},
		{
			title: 'Route profile (focused leg)',
			rows: [
				{ keys: ['↑', '↓'], text: 'Nudge the leg level by 100 ft' },
				{ keys: ['Shift+↑', 'Shift+↓'], text: 'Nudge the leg level by 500 ft' },
				{ keys: ['Enter'], text: 'Open the focused waypoint, band or obstacle' },
			],
		},
		{
			title: 'Route tab (focused route tab strip)',
			rows: [
				{ keys: ['←', '→'], text: 'Previous / next route' },
				{ keys: ['Home', 'End'], text: 'First / last route' },
			],
		},
		{
			title: 'Panel and dock edges (focused grip)',
			rows: [
				{ keys: ['←', '↑', '↓', '→'], text: 'Resize the panel, dock or sheet' },
				{ keys: ['Home'], text: 'Reset a dock to its default size' },
				{ keys: ['Enter'], text: 'Cycle the mobile sheet: peek, half, full' },
			],
		},
	] as ShortcutGroup[],
};
