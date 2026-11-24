#!/usr/bin/env bash
# check-aab.sh aab: check an Android App Bundle for what Google Play lets
# through. The bundle must declare the permissions
# android/app/src/main/AndroidManifest.xml declares, which the privacy page
# lists, plus the one androidx declares for the app's own receivers, and
# carry no native library. Run it from the repository root:
#
#	scripts/check-aab.sh android/app/build/outputs/bundle/release/app-release.aab
#
# It runs the bundletool jar that BUNDLETOOL names, or else fetches the
# release pinned below and checks its SHA-256.
set -euo pipefail

version=1.18.3
sum=a099cfa1543f55593bc2ed16a70a7c67fe54b1747bb7301f37fdfd6d91028e29
manifest=android/app/src/main/AndroidManifest.xml
androidx=fr.loxodrome.app.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION

if [ $# -ne 1 ]; then
	echo 'usage: check-aab.sh aab' >&2
	exit 2
fi
aab=$1
if [ ! -f "$manifest" ]; then
	echo "check-aab.sh: no $manifest here: run it from the repository root" >&2
	exit 1
fi
if [ ! -f "$aab" ]; then
	echo "check-aab.sh: $aab: no such file" >&2
	exit 1
fi

jar=${BUNDLETOOL-}
if [ -z "$jar" ]; then
	jar=$(mktemp) || exit 1
	trap 'rm -f "$jar"' EXIT
	curl -fsSL -o "$jar" \
		"https://github.com/google/bundletool/releases/download/$version/bundletool-all-$version.jar"
	echo "$sum  $jar" | sha256sum -c --quiet -
fi

want=$({
	sed -n 's/.*<uses-permission android:name="\([^"]*\)".*/\1/p' "$manifest"
	echo "$androidx"
} | sort)
got=$(java -jar "$jar" dump manifest --bundle="$aab" \
	--xpath=/manifest/uses-permission/@android:name | sort)
if [ "$got" != "$want" ]; then
	echo "check-aab.sh: $aab: its permissions differ from $manifest's:" >&2
	diff -u --label "$manifest" --label "$aab" \
		<(printf '%s\n' "$want") <(printf '%s\n' "$got") >&2 || true
	exit 1
fi

# Captured before the test: grep -q would close the pipe on a match, and
# pipefail would then read unzip's SIGPIPE as no match.
libs=$(unzip -Z1 "$aab" | grep '^[^/]*/lib/' || true)
if [ -n "$libs" ]; then
	echo "check-aab.sh: $aab carries native libraries:" >&2
	printf '%s\n' "$libs" >&2
	exit 1
fi
