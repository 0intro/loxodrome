/* The dialogs that hold a question of their own: a key that acts on the
 * app (Ctrl/Cmd+S, Ctrl/Cmd+P) waits for their answer. A workspace surface
 * carries none of these classes, so the keys still act under a full-screen
 * workbook (flight prep on a phone, or maximised). */

const QUESTIONS = '.confirm-box, .datum-box, .shortcuts-box, .login-box, .reset-box, .palette-box';

export function questionStanding(): boolean {
	return document.querySelector(QUESTIONS) != null;
}
