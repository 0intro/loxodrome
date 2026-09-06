/* Domaine compte et synchronisation\u202f; miroir de ../en/account.ts. */

import type { Messages } from '../en';
import { plural } from './plural';

export const account = {
	title: 'Compte',

	emailLabel: 'Adresse e-mail',
	sendCode: 'Recevoir un code',
	sending: 'Envoi',
	codeLabel: 'Code de connexion',
	codeSent: (email: string) => `Un code à 6 chiffres a été envoyé à ${email}. Il expire dans 10 minutes.`,
	codeHint: 'La première connexion crée votre compte.',
	devCodeHint: 'Service local de développement\u202f: aucun courriel n’est envoyé, le code est 000000.',
	staySignedIn: 'Rester connecté sur cet appareil',
	staySignedInTip: 'Laissez décoché sur un ordinateur partagé\u202f: la session se termine alors d’elle-même et la déconnexion retire vos données de la machine.',
	signInAction: 'Se connecter',
	back: 'Retour',
	verifying: 'Vérification',

	signedInAs: (email: string) => `Connecté en tant que ${email}`,
	sharedSession: 'Session sur ordinateur partagé',
	statusNever: 'Jamais synchronisé',
	statusSyncing: 'Synchronisation',
	statusSyncingProgress: (done: number, total: number) =>
		`Synchronisation (${done}/${total} téléversés)`,
	statusSynced: (ago: string) => `Synchronisé ${ago}`,
	justNow: 'à l’instant',
	minutesAgo: (n: number) => `il y a ${n} ${plural(n, 'minute', 'minutes')}`,
	hoursAgo: (n: number) => `il y a ${n} ${plural(n, 'heure', 'heures')}`,
	syncNow: 'Synchroniser maintenant',
	storageLine: (used: string, quota: string) => `${used} sur ${quota} utilisés`,
	pendingLine: (n: number) => `${n} ${plural(n, 'modification', 'modifications')} à téléverser`,
	unadoptedLine: (n: number) =>
		`${n} ${plural(n, 'élément de cet appareil n’est pas', 'éléments de cet appareil ne sont pas')} dans votre compte.`,
	unadoptedAdd: 'Les ajouter à mon compte',

	mergeAsk: (n: number) =>
		`Cet appareil contient ${n} ${plural(n, 'élément', 'éléments')} (plans, vols, avions) absents de votre compte. Les ajouter à votre compte\u202f?`,
	mergeDifferentAccount:
		'Cet appareil a été utilisé en dernier par un autre compte\u202f: ces données peuvent appartenir à un autre pilote.',
	mergeAdd: 'Ajouter à mon compte',
	mergeNotNow: 'Pas maintenant',

	devices: 'Vos appareils',
	deviceCurrent: 'cet appareil',
	deviceRevoke: 'Déconnecter cet appareil',
	renameDevice: 'Renommer cet appareil',
	modePersonal: 'personnel',
	modeShared: 'ordinateur partagé',
	deviceSeen: (date: string) => `vu le ${date}`,

	signOut: 'Se déconnecter',
	signOutKeep: 'Vos plans, vols et avions restent sur cet appareil.',
	signOutWipeOption: 'Retirer aussi mes données de cet appareil',
	signOutShared: 'La déconnexion retire vos données de cet ordinateur partagé.',
	signOutPending: (n: number) =>
		`${n} ${plural(n, 'modification non téléversée sera perdue', 'modifications non téléversées seront perdues')} sur cet appareil.`,
	pendingUnknown:
		'Impossible de vérifier que tout est envoyé\u202f; les modifications non envoyées seraient perdues sur cet appareil.',
	signOutAction: 'Se déconnecter',
	recordingBlocked: 'Indisponible pendant un enregistrement.',
	expiredShared: 'Cette session partagée est terminée. La déconnexion retirera vos données de cet ordinateur.',
	expiredSharedPending: 'Cette session partagée est terminée avec des modifications non téléversées.',
	authExpired: 'Session expirée. Reconnectez-vous pour continuer la synchronisation\u202f; tout continue de fonctionner sur cet appareil en attendant.',

	signOutEverywhere: 'Se déconnecter partout',
	deleteAccount: 'Supprimer mon compte',
	sudoIntro: (email: string) => `Pour confirmer, saisissez le code qui vient d’être envoyé à ${email}.`,
	sudoConfirm: 'Confirmer',
	deleteExplain:
		'Votre compte et ses données sont effacés après 7 jours\u202f; une connexion avant ce délai annule la suppression. Les copies sur vos appareils ne sont PAS retirées\u202f: chaque appareil conserve ses données et cesse simplement de synchroniser.',
	deleteStaged: (date: string) => `Suppression prévue le ${date}. Une connexion avant cette date l’annule.`,
	restoreAccount: 'Annuler la suppression',
	downloadAll: 'Télécharger une copie de mes données',

	syncError: (code: string): string => {
		switch (code) {
			case 'quota-exceeded':
				return 'Quota de stockage dépassé. Supprimez des vols ou des plans pour faire de la place.';
			case 'service-full':
				return 'Le service est complet et n’accepte pas de nouveau compte pour le moment.';
			case 'code-invalid':
				return 'Code erroné ou expiré.';
			case 'suspended':
				return 'Ce compte est suspendu.';
			case 'account-pending-delete':
				return 'Ce compte est en cours de suppression.';
			case 'rate-limited':
				return 'Trop de tentatives. Réessayez dans un instant.';
			case 'sudo-required':
				return 'Un code de confirmation récent est requis.';
			case 'blob-invalid':
				return 'Une trace n’a pas pu être téléchargée intacte.';
			case 'network':
				return 'Le service de compte est injoignable. Vérifiez votre connexion.';
			case 'internal':
				return 'Le service de compte a rencontré une erreur. Réessayez dans un instant.';
			case 'doc-too-large':
			case 'too-many-docs':
			case 'blob-too-large':
				return 'Un élément est trop volumineux pour être synchronisé.';
			default:
				return 'Erreur de synchronisation.';
		}
	},

	fetchTrace: 'Télécharger la trace',
	tracesToFetch: (n: number) =>
		`${n} ${plural(n, 'vol de votre compte a', 'vols de votre compte ont')} une trace pas encore sur cet appareil.`,

	unstoredPlanHint: 'Un plan non mémorisé ne vous suit pas sur vos autres appareils.',
	resetSignsOut: 'La réinitialisation déconnecte aussi cet appareil de son compte.',

	conflictCopy: (date: string) => `copie en conflit ${date}`,
} satisfies Messages['account'];
