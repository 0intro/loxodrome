/* Le catalogue français: miroir exact de ../en (chaque fichier de domaine
 * porte son propre satisfies pour des erreurs localisées; celui-ci verrouille
 * l'ensemble). */

import type { Messages } from '../en';
import { about } from './about';
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

export const fr = {
	about,
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
} satisfies Messages;
