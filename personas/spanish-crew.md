# Persona: Crew Member — Spanish (es)

**Who:** A Spanish-speaking crew member who works entirely in Spanish. Competent at
the job; the language is the variable being tested, not the user's ability.

**Login:** test account (logs in himself when prompted).

**Setup:** switch the app language to Spanish (`es`) BEFORE doing anything else,
via whatever in-app language toggle exists. Note how easy/hard it was to find.

**Primary goal:** Do a normal count-and-submit flow start to finish in Spanish, the
same kind of work the field tech does — but the real target is i18n quality.

**Believable path:**
1. Switch language to Spanish.
2. Navigate to a location and count a few items.
3. Submit.
4. Trigger at least one error or validation message (e.g. leave a required field
   blank) to check that *error* strings are translated too — those are the most
   commonly missed.
5. Throughout, screenshot every distinct screen.

**Features this persona must cover:** language toggle, i18n across navigation, count
entry, validation/error strings in Spanish, any date/number formatting.

**What this persona records (capture in `felt` AND flag explicitly per step):**
every string still showing in English, every place text overflows or breaks layout
in Spanish, any mixed-language screen, any untranslated error/toast. Be exhaustive
about untranslated strings — list them with the screen they appear on. This is the
whole reason this persona exists.
