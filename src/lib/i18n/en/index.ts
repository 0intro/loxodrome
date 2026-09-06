/* The English catalog: the source of truth for the message shape. Every
 * domain the app renders text from is one file here with a French mirror in
 * ../fr; `Messages` is derived from this object, so a key added on one side
 * without the other fails `npm run check` (contract: docs/i18n.md). */

import { about } from './about';
import { account } from './account';
import { aircraft } from './aircraft';
import { common } from './common';
import { conditions } from './conditions';
import { data } from './data';
import { detail } from './detail';
import { display } from './display';
import { errors } from './errors';
import { filter } from './filter';
import { flightprep } from './flightprep';
import { flights } from './flights';
import { input } from './input';
import { layers } from './layers';
import { map } from './map';
import { navigation } from './navigation';
import { navlog } from './navlog';
import { notam } from './notam';
import { qcode } from './qcode';
import { route } from './route';
import { search } from './search';
import { shortcuts } from './shortcuts';
import { tabs } from './tabs';
import { weather } from './weather';

export const en = {
	about,
	account,
	aircraft,
	common,
	conditions,
	data,
	detail,
	display,
	errors,
	filter,
	flightprep,
	flights,
	input,
	layers,
	map,
	navigation,
	navlog,
	notam,
	qcode,
	route,
	search,
	shortcuts,
	tabs,
	weather,
};

/** The message-catalog shape; en is the source of truth, fr must satisfy it. */
export type Messages = typeof en;
