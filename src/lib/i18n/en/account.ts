/* The account + sync domain (docs/accounts-sync.md): the Settings tab's
 * Account group, the sign-in flow, the sync status line, the lifecycle
 * confirms, and the conflict-copy captions the replicator writes INTO
 * content (a caption is worded once, in the device's locale at conflict
 * time, and then lives in the file). */

import { plural } from './plural';

export const account = {
	title: 'Account',

	/* The sign-in flow. */
	emailLabel: 'E-mail address',
	sendCode: 'Send me a code',
	sending: 'Sending',
	codeLabel: 'Sign-in code',
	codeSent: (email: string) => `A 6-digit code was sent to ${email}. It expires in 10 minutes.`,
	codeHint: 'First sign-in creates your account.',
	devCodeHint: 'Local dev service: no mail is sent, the code is 000000.',
	staySignedIn: 'Stay signed in on this device',
	staySignedInTip: 'Leave unchecked on a shared computer: the session then ends by itself and signing out removes your data from the machine.',
	signInAction: 'Sign in',
	back: 'Back',
	verifying: 'Verifying',

	/* Signed in. */
	signedInAs: (email: string) => `Signed in as ${email}`,
	sharedSession: 'Shared-computer session',
	statusNever: 'Not synced yet',
	statusSyncing: 'Syncing',
	statusSyncingProgress: (done: number, total: number) => `Syncing (${done}/${total} uploaded)`,
	statusSynced: (ago: string) => `Synced ${ago}`,
	justNow: 'just now',
	minutesAgo: (n: number) => `${n} ${plural(n, 'minute', 'minutes')} ago`,
	hoursAgo: (n: number) => `${n} ${plural(n, 'hour', 'hours')} ago`,
	syncNow: 'Sync now',
	storageLine: (used: string, quota: string) => `${used} of ${quota} used`,
	pendingLine: (n: number) => `${n} ${plural(n, 'change', 'changes')} to upload`,
	unadoptedLine: (n: number) =>
		`${n} ${plural(n, 'item', 'items')} on this device ${plural(n, 'is', 'are')} not in your account.`,
	unadoptedAdd: 'Add them to my account',

	/* The merge confirm. */
	mergeAsk: (n: number) =>
		`This device holds ${n} ${plural(n, 'item', 'items')} (plans, flights, aircraft) not in your account. Add them to your account?`,
	mergeDifferentAccount:
		'This device was last used by a different account, so this data may belong to another pilot.',
	mergeAdd: 'Add to my account',
	mergeNotNow: 'Not now',

	/* Devices. */
	devices: 'Your devices',
	deviceCurrent: 'this device',
	deviceRevoke: 'Sign out this device',
	renameDevice: 'Rename this device',
	modePersonal: 'personal',
	modeShared: 'shared computer',
	deviceSeen: (date: string) => `seen ${date}`,

	/* Sign out. */
	signOut: 'Sign out',
	signOutKeep: 'Your plans, flights and aircraft stay on this device.',
	signOutWipeOption: 'Also remove my data from this device',
	signOutShared: 'Signing out removes your data from this shared computer.',
	signOutPending: (n: number) =>
		`${n} ${plural(n, 'change is', 'changes are')} not uploaded yet and will be lost on this device.`,
	pendingUnknown:
		'Whether everything is uploaded could not be checked; unsent changes would be lost on this device.',
	signOutAction: 'Sign out',
	recordingBlocked: 'Not available while a recording is running.',
	expiredShared: 'This shared session has ended. Signing out will remove your data from this computer.',
	expiredSharedPending: 'This shared session has ended with changes not uploaded yet.',
	authExpired: 'Session expired. Sign in again to keep syncing; everything keeps working on this device meanwhile.',

	/* Sudo actions. */
	signOutEverywhere: 'Sign out everywhere',
	deleteAccount: 'Delete my account',
	sudoIntro: (email: string) => `To confirm, enter the fresh code just sent to ${email}.`,
	sudoConfirm: 'Confirm',
	deleteExplain:
		'Your account and its data are erased after 7 days; signing in before then cancels the deletion. The copies on your devices are NOT removed: each device keeps its data and simply stops syncing.',
	deleteStaged: (date: string) =>
		`Deletion scheduled for ${date}. Signing in before then cancels it.`,
	restoreAccount: 'Cancel the deletion',
	downloadAll: 'Download a copy of my data',

	/* Sync errors, worded from the server's typed codes. */
	syncError: (code: string): string => {
		switch (code) {
			case 'quota-exceeded':
				return 'Storage quota exceeded. Delete some flights or plans to make room.';
			case 'service-full':
				return 'The service is full and accepts no new accounts for now.';
			case 'code-invalid':
				return 'Wrong or expired code.';
			case 'suspended':
				return 'This account is suspended.';
			case 'account-pending-delete':
				return 'This account is scheduled for deletion.';
			case 'rate-limited':
				return 'Too many attempts. Retry in a moment.';
			case 'sudo-required':
				return 'A fresh confirmation code is required.';
			case 'blob-invalid':
				return 'A trace failed to download intact.';
			case 'network':
				return 'The account service could not be reached. Check your connection.';
			case 'internal':
				return 'The account service hit an error. Try again shortly.';
			case 'doc-too-large':
			case 'too-many-docs':
			case 'blob-too-large':
				return 'An item is too large to sync.';
			default:
				return 'Sync error.';
		}
	},

	/* The Flights surface's shared-mode affordance. */
	fetchTrace: 'Download the trace',
	tracesToFetch: (n: number) =>
		`${n} ${plural(n, 'flight', 'flights')} in your account ${plural(n, 'has', 'have')} a trace not yet on this device.`,

	/* Cross-surface hints. */
	unstoredPlanHint: 'An unstored plan does not follow you to your other devices.',
	resetSignsOut: 'Resetting also signs this device out of its account.',

	/** The caption suffix a plan conflict copy carries (the Dropbox
	 *  convention); `date` is the day it was made. */
	conflictCopy: (date: string) => `conflicted copy ${date}`,
};
