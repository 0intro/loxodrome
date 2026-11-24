package main

import (
	"encoding/json"
	"reflect"
	"testing"
)

// TestParsePhones: the numbers the supplements print, each with the role
// of its section or clause and the lines of its label, rows spaced as
// poppler reads them and jammed as the native reader does.
func TestParsePhones(t *testing.T) {
	one := func(texts ...string) []prow {
		var rows []prow
		for i, s := range texts {
			rows = append(rows, row(float64(800-12*i), cell{46, s}))
		}
		return rows
	}
	for _, c := range []struct {
		name string
		rows []prow
		want []phoneEntry
	}{
		{"191/2025, the real activity known by telephone", one(
			"INFORMATION DES USAGERS",
			"Activité réelle connue de :",
			"Responsable des opérations :     06 62 83 60 48 ou 06 30 32 20 97",
			"ORGANISME GESTIONNAIRE",
			"DELAIR",
			"Responsable des opérations :     06 62 83 60 48 ou 06 30 32 20 97",
			"CONDITIONS DE PÉNÉTRATION",
			"contournement de la zone, après coordination avec le gestionnaire (Tél : 06 62 83 60 48 ou 06 30 32 20 97) ;",
		), []phoneEntry{{roleKnown, []string{"Responsable des opérations"}, []string{"06 62 83 60 48", "06 30 32 20 97"}}}},
		{"191/2025, jammed", []prow{
			row(124, cell{58, "INFORMATIONDESUSAGERS"}),
			row(112, cell{58, "Activit\uFFFDr\uFFFDelleconnuede:"}),
			row(100, cell{58, "Responsabledesop\uFFFDrations:"}, cell{166, "0662836048ou0630322097"}),
		}, []phoneEntry{{roleKnown, []string{"Responsabledesop\uFFFDrations"}, []string{"06 62 83 60 48", "06 30 32 20 97"}}}},
		{"153/2026, the manager", one(
			"GESTIONNAIRES",
			"GAILLARD ASA : 07 59 93 49 49",
			"ORGANISMES A CONTACTER",
			"GAILLARD ASA : 07 59 93 49 49",
		), []phoneEntry{{roleManager, []string{"GAILLARD ASA"}, []string{"07 59 93 49 49"}}}},
		{"106/2026, a label on the line above, a capitalised word no heading", one(
			"ORGANISMES A CONTACTER",
			"ARGENTELLA, LUMIO et DRONE LUMIO :",
			"DIREX CORSE",
			"Téléphone : 06.80.31.07.89",
			"- ZRT BONIFACIO et DRONE BONIFACIO :",
			"Organisme de Contrôle d’Ajaccio et Figari",
			"Téléphone : 04.95.23.59.60 Ajaccio APP / 04.95.76.77.30 Figari TWR",
		), []phoneEntry{
			{roleContact, []string{"DIREX CORSE"}, []string{"06 80 31 07 89"}},
			{roleContact, []string{"Organisme de Contrôle d’Ajaccio et Figari"}, []string{"04 95 23 59 60", "04 95 76 77 30"}},
		}},
		{"041/2026, a label closing on its colon", one(
			"ORGANISMES A CONTACTER",
			"Directeur des vols :",
			"     Téléphone : 06 30 32 20 97",
		), []phoneEntry{{roleContact, []string{"Directeur des vols"}, []string{"06 30 32 20 97"}}}},
		{"before and during the activity", one(
			"Activité réelle connue de :",
			"- avant l'activité : PC Belmont : 05 63 00 00 01",
			"- pendant l'activité : Officier de tir : 05 63 00 00 02",
		), []phoneEntry{
			{roleBefore, []string{"PC Belmont"}, []string{"05 63 00 00 01"}},
			{roleDuring, []string{"Officier de tir"}, []string{"05 63 00 00 02"}},
		}},
		{"062/2026, two columns, each its own clause", []prow{
			row(309, cell{234, "ORGANISMESACONTACTER"}),
			row(294, cell{46, "HorsactivationdesZRT:"}, cell{300, "Pendantl\x19activationdesZRT:"}),
			row(283, cell{46, "QuestionsrelativesauSUPAIP:"}),
			row(272, cell{300, "CentredeD\uFFFDtectionetdeContr\uFFFDlemilitaire(CDC)"}),
			row(261, cell{46, "CentreD\uFFFDfensedeProgrammationetdeGestionde"}, cell{300, "deMont-de-Marsan"}),
			row(249, cell{46, "l\x19Espace(CDPGE)"}, cell{300, "T\uFFFDl\uFFFDphone:0558068451ou0558461735."}),
			row(227, cell{46, "T\uFFFDl\uFFFDphone:0181860782ou0181860781."}, cell{300, "CentredeD\uFFFDtectionetdeContr\uFFFDlemilitaire(CDC)"}),
			row(216, cell{300, "deLyonMontVerdun(CDCderemplacement)"}),
			row(204, cell{46, "PNIA:861.428.31.82."}, cell{300, "T\uFFFDl\uFFFDphone:0487655521ou0487656199."}),
			row(131, cell{218, "DISPOSITIONSCOMPLEMENTAIRES"}),
			row(117, cell{82, "LeszonesTRA34A,TRA43A,LF-R34A2etlesLF-R68serontactiv\uFFFDes"}),
		}, []phoneEntry{
			{roleDuring, []string{"CentredeD\uFFFDtectionetdeContr\uFFFDlemilitaire(CDC)", "deMont-de-Marsan"}, []string{"05 58 06 84 51", "05 58 46 17 35"}},
			{roleBefore, []string{"CentreD\uFFFDfensedeProgrammationetdeGestionde", "l\x19Espace(CDPGE)"}, []string{"01 81 86 07 82", "01 81 86 07 81"}},
			{roleDuring, []string{"CentredeD\uFFFDtectionetdeContr\uFFFDlemilitaire(CDC)", "deLyonMontVerdun(CDCderemplacement)"}, []string{"04 87 65 55 21", "04 87 65 61 99"}},
		}},
		{"053/2026, labels over two lines, a number on the next, figures ending an entry", []prow{
			row(390, cell{234, "ORGANISMESACONTACTER"}),
			row(376, cell{46, "Avantl'op\uFFFDration:"}, cell{300, "Pendantl'op\uFFFDration:"}),
			row(353, cell{46, "UniquementpourlaPPS("}, cell{154, "s\uFFFDret\uFFFD"}, cell{181, ")"}, cell{184, ":"}, cell{300, "CentredeD\uFFFDtectionetdeContr\uFFFDlemilitaire("}, cell{492, "CDC"}, cell{510, ")de"}),
			row(342, cell{46, "CommandementdelaD\uFFFDfenseA\uFFFDrienneetdes"}, cell{300, "Cinq-Mars-la-Pile-T\uFFFDl\uFFFDphone:"}, cell{432, "0245341567"}),
			row(331, cell{46, "Op\uFFFDrationsA\uFFFDriennes-Lyon/DivisionDPSA"}),
			row(319, cell{46, "T\uFFFDl\uFFFDphone:0487655224ou0487655086/PNIA:864"}, cell{300, "CentredeD\uFFFDtectionetdeContr\uFFFDlemilitaire("}, cell{492, "CDC"}, cell{510, ")de"}),
			row(308, cell{46, "9426224ou8649427086"}, cell{300, "Mont-de-Marsan-T\uFFFDl\uFFFDphone:0558054903"}),
			row(286, cell{46, "Exercicesouentra\uFFFDnements"}, cell{163, ":"}, cell{300, "PPSau-dessusdeParis"}, cell{397, ":\uFFFDl\uFFFDmentAirdeContr\uFFFDlede"}),
			row(274, cell{46, "CommandementdelaD\uFFFDfenseA\uFFFDrienneetdes"}, cell{300, "l'A\uFFFDroportParisCDG("}, cell{393, "EACA"}, cell{415, ")-T\uFFFDl\uFFFDphone:0672796242"}),
			row(263, cell{46, "Op\uFFFDrationsA\uFFFDriennes/EMO/A7-Lyon/DivisionEspaces"}, cell{300, "ou0148166537"}),
			row(252, cell{46, "A\uFFFDriens"}),
			row(241, cell{46, "T\uFFFDl\uFFFDphone:0487655798ou0487655799/PNIA:864"}),
			row(229, cell{46, "9424798ou8649424799"}),
		}, []phoneEntry{
			{roleDuring, []string{"CentredeD\uFFFDtectionetdeContr\uFFFDlemilitaire( CDC )de", "Cinq-Mars-la-Pile"}, []string{"02 45 34 15 67"}},
			{roleBefore, []string{"CommandementdelaD\uFFFDfenseA\uFFFDrienneetdes", "Op\uFFFDrationsA\uFFFDriennes-Lyon/DivisionDPSA"}, []string{"04 87 65 52 24", "04 87 65 50 86"}},
			{roleDuring, []string{"CentredeD\uFFFDtectionetdeContr\uFFFDlemilitaire( CDC )de", "Mont-de-Marsan"}, []string{"05 58 05 49 03"}},
			{roleDuring, []string{"PPSau-dessusdeParis :\uFFFDl\uFFFDmentAirdeContr\uFFFDlede", "l'A\uFFFDroportParisCDG( EACA )"}, []string{"06 72 79 62 42", "01 48 16 65 37"}},
			{roleBefore, []string{"CommandementdelaD\uFFFDfenseA\uFFFDrienneetdes", "Op\uFFFDrationsA\uFFFDriennes/EMO/A7-Lyon/DivisionEspaces", "A\uFFFDriens"}, []string{"04 87 65 57 98", "04 87 65 57 99"}},
		}},
		{"029/2026, an address walked past", []prow{
			row(484, cell{234, "ORGANISMESACONTACTER"}),
			row(470, cell{46, "Avantl'exercice:"}, cell{300, "Pendantl\x19exercice:"}),
			row(448, cell{46, "CFAS/BRIGADEOP\uFFFDRATIONS/D5PLANSOP\uFFFDRATIONS"}, cell{300, "OrganismeGESTIONNAIREdel\x19espace(OGE)"}),
			row(436, cell{46, "NUCL\uFFFDAIRES"}),
			row(425, cell{46, "\uFFFDL\uFFFDMENTAIRRATTACHE921"}),
			row(414, cell{46, "95155TAVERNYCEDEX"}),
			row(403, cell{46, "T\uFFFDl\uFFFDphone:0182413655/0182413881"}),
			row(391, cell{46, "ADRESSET\uFFFDL\uFFFDGRAPHIQUE"}),
		}, []phoneEntry{
			{roleBefore, []string{"CFAS/BRIGADEOP\uFFFDRATIONS/D5PLANSOP\uFFFDRATIONS", "NUCL\uFFFDAIRES", "\uFFFDL\uFFFDMENTAIRRATTACHE921"}, []string{"01 82 41 36 55", "01 82 41 38 81"}},
		}},
		{"059/2026, a label closing on its colon under its first line", []prow{
			row(558, cell{234, "ORGANISMESACONTACTER"}),
			row(544, cell{46, "Avantl'exercice:"}, cell{300, "Pendantl'exercice:"}),
			row(521, cell{46, "COMALATSectionEspaceA\uFFFDrien"}, cell{300, "CentredeD\uFFFDtectionetdeContr\uFFFDlemilitaire(CDC)"}),
			row(510, cell{46, "T\uFFFDl\uFFFDphone:03.87.15.58.86/58.87"}, cell{300, "deCinq-Mars-La-Pile:"}),
			row(499, cell{300, "T\uFFFDl\uFFFDphone:02.45.34.15.67(Chefcontr\uFFFDleur)"}),
		}, []phoneEntry{
			{roleBefore, []string{"COMALATSectionEspaceA\uFFFDrien"}, []string{"03 87 15 58 86"}},
			{roleDuring, []string{"CentredeD\uFFFDtectionetdeContr\uFFFDlemilitaire(CDC)", "deCinq-Mars-La-Pile"}, []string{"02 45 34 15 67"}},
		}},
		{"175/2026, a second number under the first", []prow{
			row(180, cell{234, "ORGANISMESACONTACTER"}),
			row(166, cell{46, "CIFED"}),
			row(154, cell{46, "Tel:0413938540(bureauSalondeProvence)"}),
			row(142, cell{46, "Port:0664237162"}),
		}, []phoneEntry{{roleContact, []string{"CIFED"}, []string{"04 13 93 85 40", "06 64 23 71 62"}}}},
		{"191/2026, a bullet read as \"&f\", the number in brackets", []prow{
			row(203, cell{234, "ORGANISMESACONTACTER"}),
			row(189, cell{46, "Avantl'activit\uFFFD:"}),
			row(179, cell{46, "&fCelluleparachutismeduMININT/MINARM(T\uFFFDl\uFFFDphone:0684838584/0624927885)."}),
		}, []phoneEntry{{roleBefore, []string{"CelluleparachutismeduMININT/MINARM"}, []string{"06 84 83 85 84", "06 24 92 78 85"}}}},
		{"a_2026_056, numbers from abroad, a fax left out", []prow{
			row(478, cell{234, "ORGANISMESACONTACTER"}),
			row(464, cell{46, "AIRFRANCE"}),
			row(452, cell{46, "-Usagerscommerciaux"}),
			row(440, cell{46, "+33(0)607857405-FAX:0497117421"}),
			row(416, cell{46, "Courriel:"}, cell{87, "ops.nce@airfrance.fr"}),
			row(393, cell{46, "AVIAPARTNER"}),
			row(381, cell{46, "-Usagerscommerciaux"}),
			row(369, cell{46, "+33(0)493215955-Fax:+33(0)493214335"}),
			row(357, cell{46, "SITA:NCEOPXH\x13RSFTA:LFMNXHAK"}),
			row(300, cell{46, "H\uFFFDLIAIRMONACO(h\uFFFDlicopt\uFFFDresseulement)"}),
			row(288, cell{46, "+37792050050-Fax:+37792050051"}),
			row(276, cell{46, "H\uFFFDLISECURITE(h\uFFFDlicopt\uFFFDresseulement)"}),
			row(264, cell{46, "0494555999"}),
		}, []phoneEntry{
			{roleContact, []string{"AIRFRANCE", "Usagerscommerciaux"}, []string{"06 07 85 74 05"}},
			{roleContact, []string{"AVIAPARTNER", "Usagerscommerciaux"}, []string{"04 93 21 59 55"}},
			{roleContact, []string{"H\uFFFDLISECURITE(h\uFFFDlicopt\uFFFDresseulement)"}, []string{"04 94 55 59 99"}},
		}},
		{"110/2026, a unit under its commands, its address walked past", []prow{
			row(760, cell{234, "ORGANISMESACONTACTER"}),
			row(738, cell{46, "CommandementdelaD\uFFFDfensea\uFFFDrienneetdesOp\uFFFDrationsa\uFFFDriennes"}),
			row(726, cell{46, "CentreAirdePlani\uFFFD\x01cationetdeConduitedesOp\uFFFDrationsetdeD\uFFFDfenseA\uFFFDrienne-TerritoireNational"}),
			row(714, cell{46, "DispositifParticulierdeSuret\uFFFDA\uFFFDrienne"}),
			row(703, cell{46, "BaseA\uFFFDrienne942deLyonMont-Verdun"}),
			row(691, cell{46, "BP19"}),
			row(679, cell{46, "69579LIMONESTCEDEX"}),
			row(667, cell{46, "T\uFFFDl.:+33(0)4.87.65.61.41"}),
		}, []phoneEntry{{roleContact, []string{"DispositifParticulierdeSuret\uFFFDA\uFFFDrienne", "BaseA\uFFFDrienne942deLyonMont-Verdun"}, []string{"04 87 65 61 41"}}}},
		{"176/2025, an address for mail walked past", []prow{
			row(500, cell{250, "ORGANISMEGESTIONNAIRE"}),
			row(488, cell{46, "Soci\uFFFDt\uFFFDRIFT"}),
			row(476, cell{46, "Mail:contact@rift.aero"}),
			row(464, cell{46, "T\uFFFDl.:0651219269ou0607219846ou0689652874"}),
		}, []phoneEntry{{roleManager, []string{"Soci\uFFFDt\uFFFDRIFT"}, []string{"06 51 21 92 69", "06 07 21 98 46", "06 89 65 28 74"}}}},
		{"170/2026, a label opening its section in small letters", []prow{
			row(300, cell{250, "GESTIONNAIRES"}),
			row(288, cell{46, "directiondesvols:0642430126/0682556401"}),
		}, []phoneEntry{{roleManager, []string{"directiondesvols"}, []string{"06 42 43 01 26", "06 82 55 64 01"}}}},
		{"a_2026_193, a label line in a section naming no one to call", []prow{
			row(698, cell{197, "Contactsentit\uFFFDsaccueillantes/"}, cell{333, "ContactsofGeneralAviationhostentities:"}),
			row(686, cell{197, "-FINIST'AIR:"}),
			row(675, cell{197, "+33298846487"}),
		}, []phoneEntry{{roleContact, []string{"FINIST'AIR"}, []string{"02 98 84 64 87"}}}},
		{"144/2026, a penetration rule's sentence over its number", []prow{
			row(444, cell{228, "CONDITIONSDEP\uFFFDN\uFFFDTRATION"}),
			row(430, cell{46, "CAG/CAM"}, cell{89, ":contournementobligatoiredurantl'activit\uFFFDsaufa\uFFFDronefsparticipantauchampionnat,a\uFFFDronefsbas\uFFFDs"}),
			row(420, cell{46, "apr\uFFFDsaccordpr\uFFFDalabledel\x19exploitanteta\uFFFDronefsassurantdesop\uFFFDrationsd'urgence,d'assistanceoudesauvetage"}),
			row(410, cell{46, "quandlecontournementn'estpaspossibleapr\uFFFDscontactavecl\x19organisateurau06.18.02.24.97."}),
		}, []phoneEntry{{roleContact, nil, []string{"06 18 02 24 97"}}}},
		{"a_2026_072, a sentence about calling", []prow{
			row(776, cell{270, "PR\uFFFDAMBULE"}),
			row(751, cell{46, "l\x19Exploitanta\uFFFDroportuaire.ContactEDEISA\uFFFDroportLeMansArnage:"}),
			row(740, cell{76, "part\uFFFDl\uFFFDphone:(France+33)0243840043"}),
		}, []phoneEntry{{roleContact, nil, []string{"02 43 84 00 43"}}}},
		{"055/2026, the tail of a bracket ending the walk", []prow{
			row(540, cell{234, "ORGANISMESACONTACTER"}),
			row(530, cell{46, "Avantl'exercice:"}, cell{300, "Pendantl'exercice:"}),
			row(521, cell{300, "CentredeD\uFFFDtectiondeContr\uFFFDlemilitaire(CDC)deLyonMontVerdun"}),
			row(510, cell{46, "PNIA:8649426369"}, cell{300, "T\uFFFDl\uFFFDphone:"}, cell{350, "0487656199"}, cell{420, "ou0487655521(chef"}),
			row(499, cell{300, "contr\uFFFDleur)"}),
			row(488, cell{46, "Danslecadred\x19exercicesouentrainements:"}),
			row(476, cell{46, "CommandementdelaD\uFFFDfenseA\uFFFDrienneetdes"}, cell{300, "CentredeD\uFFFDtectiondeContr\uFFFDlemilitaire(CDC)deCinq-"}),
			row(465, cell{46, "Op\uFFFDrationsA\uFFFDriennes-Lyon/EMOA7"}, cell{300, "Mars-la-Pile(indicativeRAKI)"}),
			row(454, cell{46, "T\uFFFDl\uFFFDphone:0487655405"}, cell{165, "ou0487655799"}, cell{300, "T\uFFFDl\uFFFDphone:"}, cell{353, "0245341567"}),
		}, []phoneEntry{
			{roleDuring, []string{"CentredeD\uFFFDtectiondeContr\uFFFDlemilitaire(CDC)deLyonMontVerdun"}, []string{"04 87 65 61 99", "04 87 65 55 21"}},
			{roleBefore, []string{"CommandementdelaD\uFFFDfenseA\uFFFDrienneetdes", "Op\uFFFDrationsA\uFFFDriennes-Lyon/EMOA7"}, []string{"04 87 65 54 05", "04 87 65 57 99"}},
			{roleDuring, []string{"CentredeD\uFFFDtectiondeContr\uFFFDlemilitaire(CDC)deCinq-", "Mars-la-Pile(indicativeRAKI)"}, []string{"02 45 34 15 67"}},
		}},
		{"097/2026, a bracket over two lines of a label", []prow{
			row(560, cell{234, "ORGANISMESACONTACTER"}),
			row(543, cell{46, "T\uFFFDl\uFFFDphone:0487655405ou0487655799"}, cell{300, "T\uFFFDl\uFFFDphone:0558068451"}),
			row(532, cell{46, "PNIA8649424799(5405)"}),
			row(520, cell{300, "CentredeD\uFFFDtectionetdeContr\uFFFDlemilitaire(CDC"}),
			row(509, cell{46, "POCCIETWhiteCell"}, cell{300, "deRemplacement)deLyonMontVerdun"}),
			row(498, cell{46, "T\uFFFDl\uFFFDphone:0245407034"}, cell{300, "T\uFFFDl\uFFFDphone:0487656199ou0487655521"}),
		}, []phoneEntry{
			{roleContact, nil, []string{"04 87 65 54 05", "04 87 65 57 99"}},
			{roleContact, nil, []string{"05 58 06 84 51"}},
			{roleContact, []string{"POCCIETWhiteCell"}, []string{"02 45 40 70 34"}},
			{roleContact, []string{"CentredeD\uFFFDtectionetdeContr\uFFFDlemilitaire(CDC", "deRemplacement)deLyonMontVerdun"}, []string{"04 87 65 61 99", "04 87 65 55 21"}},
		}},
		{"021/2026 and 213/2026, a number cut at the end of its line", []prow{
			row(400, cell{234, "ORGANISMESACONTACTER"}),
			row(388, cell{46, "CDC(CentredeD\uFFFDtectionetdeContr\uFFFDlemilitaire)deLYONMONTVERDUN(Chefcontr\uFFFDleurduCDC):+33(0)48765"}),
			row(376, cell{46, "6199"}),
			row(352, cell{228, "CONDITIONSDEP\uFFFDN\uFFFDTRATION"}),
			row(340, cell{46, "nepermettentpaslecontournementdelazoneapr\uFFFDscontactavecladirectiondesvols(T\uFFFDl:0630322097ou06"}),
			row(328, cell{46, "32095436)."}),
		}, []phoneEntry{
			{roleContact, []string{"CDC(CentredeD\uFFFDtectionetdeContr\uFFFDlemilitaire)deLYONMONTVERDUN(Chefcontr\uFFFDleurduCDC)"}, []string{"04 87 65 61 99"}},
			{roleContact, nil, []string{"06 30 32 20 97", "06 32 09 54 36"}},
		}},
		{"a_2026_056, a trunk 0 printed after the country code", []prow{
			row(400, cell{234, "ORGANISMESACONTACTER"}),
			row(388, cell{46, "BLADE(h\uFFFDlicopt\uFFFDresseulement)"}),
			row(376, cell{46, "+330614966887-+33647863245"}),
		}, []phoneEntry{{roleContact, []string{"BLADE(h\uFFFDlicopt\uFFFDresseulement)"}, []string{"06 14 96 68 87", "06 47 86 32 45"}}}},
		{"002/2026, a sentence across the page outside the contacts", []prow{
			row(-176, cell{72, "47\u00b057'23''N,002\u00b024'36''W"}, cell{300, "47\u00b057'23''N,002\u00b024'36''W"}),
			row(-186, cell{72, "47\u00b045'05''N,002\u00b018'15''W"}, cell{300, "47\u00b045'05''N,002\u00b018'15''W"}),
			row(-196, cell{271, "INFORMATIONS"}),
			row(-217, cell{96, "\u2666Pr\u00e9visiond\u2019activit\u00e9disponible\u00e0partirdeJ-1:"}),
			row(-227, cell{93, "-part\u00e9l\u00e9phone"}, cell{145, ":aupr\u00e8sduCCMARATLANTIQUE"}, cell{261, "(06h00-16h00"}, cell{309, "UTC),tel:+33(0)298138265,"}),
		}, []phoneEntry{{roleContact, nil, []string{"02 98 13 82 65"}}}},
		{"242/2026, a number a sentence closes", one(
			"CONDITIONS DE PÉNÉTRATION",
			"missions et lorsque celles-ci ne permettent pas le contournement",
			"avec le responsable des activités (TEL : 06 80 12 61 13) ;",
		), []phoneEntry{{roleContact, nil, []string{"06 80 12 61 13"}}}},
	} {
		if got := parsePhones(c.rows); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s:\n  got  %q\n  want %q", c.name, got, c.want)
		}
	}
}

// TestPhoneLabelText: a label's lines read as one, the telephone words and
// the colons off its end.
func TestPhoneLabelText(t *testing.T) {
	for _, c := range []struct {
		label []string
		want  string
	}{
		{[]string{"Tour de Phalsbourg : Téléphone"}, "Tour de Phalsbourg"},
		{[]string{"DIREX CORSE Tél. :"}, "DIREX CORSE"},
		{[]string{"Centre de Détection et de Contrôle militaire (CDC)", "de Lyon Mont Verdun"}, "Centre de Détection et de Contrôle militaire (CDC) de Lyon Mont Verdun"},
		{[]string{"Cellule Opérations Tél/Fax"}, "Cellule Opérations"},
		{[]string{"Téléphones"}, ""},
		{[]string{"Tél : P1"}, "P1"},
		{[]string{"Jeanne MARTIN jeanne.martin@example.fr Directrice des travaux"}, "Jeanne MARTIN Directrice des travaux"},
		{[]string{"Escadron des services de la Circulation Aérienne (ESCA) de Mont-", "de-Marsan."}, "Escadron des services de la Circulation Aérienne (ESCA) de Mont-de-Marsan"},
		{nil, ""},
	} {
		if got := (phoneEntry{label: c.label}).labelText(); got != c.want {
			t.Errorf("labelText(%q) = %q, want %q", c.label, got, c.want)
		}
	}
}

// TestRespaceLabels: a label line takes its spaced original from the layout
// text, a line the text lacks is marked garbled, and a short name passes.
func TestRespaceLabels(t *testing.T) {
	layout := "Avant les dates d'exercice :                Durant l'exercice :\n" +
		"COMALAT                                     Directeur d’exercice (DIREX)\n" +
		"P1 : 06 89 77 13 72\n"
	norm, pos := normWithIndex(layout)
	for _, c := range []struct{ line, want string }{
		{"TALAMOC", "\uFFFD"},
		{"Directeurd\x19exercice(DIREX)", "Directeur d’exercice (DIREX)"},
		{"P1", "P1"},
	} {
		ps := []phoneEntry{{label: []string{c.line}}}
		respaceLabels(ps, layout, norm, pos)
		if got := ps[0].label[0]; got != c.want {
			t.Errorf("respaceLabels(%q) = %q, want %q", c.line, got, c.want)
		}
	}
}

// TestLapsePhones: a supplement whose validity has ended gives no number,
// fresh or retained.
func TestLapsePhones(t *testing.T) {
	entry := []phoneJSON{{Role: roleKnown, Numbers: []string{"06 62 83 60 48"}}}
	row := func(validTo string) []any {
		r := make([]any, len(outputFields))
		r[8] = validTo
		r[phonesColumn] = entry
		return r
	}
	ended, inForce, open := row("2026-11-21"), row("2026-11-22"), row("")
	raw := make([]json.RawMessage, len(outputFields))
	for i := range raw {
		raw[i] = json.RawMessage("null")
	}
	raw[8] = json.RawMessage(`"2026-10-01"`)
	raw[phonesColumn] = json.RawMessage(`[{"role":"known","numbers":["06 62 83 60 48"]}]`)
	if n := lapsePhones([]any{ended, inForce, open, raw}, "2026-11-22"); n != 2 {
		t.Errorf("lapsePhones kept numbers in %d rows, want 2", n)
	}
	if got := ended[phonesColumn]; !reflect.DeepEqual(got, []phoneJSON{}) {
		t.Errorf("ended row phones = %v, want none", got)
	}
	for _, r := range [][]any{inForce, open} {
		if !reflect.DeepEqual(r[phonesColumn], entry) {
			t.Errorf("row in force (to %q) phones = %v, want kept", r[8], r[phonesColumn])
		}
	}
	if string(raw[phonesColumn]) != "[]" {
		t.Errorf("retained ended row phones = %s, want []", raw[phonesColumn])
	}
}
