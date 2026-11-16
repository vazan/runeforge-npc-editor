# Composants tiers livrés avec l'application

> Généré par `pnpm exec tsx scripts/licenses-report.ts --markdown` le 2026-11-15 (hors ligne : `pnpm licenses list` et `cargo metadata --offline` pour la cible Windows). Il ne liste que ce qui est **lié à l'exécutable ou embarqué dans le
> frontend** (arête « normale » des dépendances) ; les outils de construction et de test ne sont pas livrés. Ce tableau est un **inventaire**, pas le paquet de notices : les textes de licence et avis de droits
> d'auteur de chaque composant doivent être rassemblés au moment du packaging (voir `LEGAL.md`). Ce n'est pas un avis juridique.

La bibliothèque de scripting rAthena générée dans `packages/emulator-rathena/src/script-library.ts` n'est pas une dépendance pnpm ou Cargo et n'apparaît donc pas dans le tableau ci-dessous. Elle contient 667 commandes, dont le texte du manuel de 662 commandes, est attribuée à rAthena Dev Team et est distribuée sous GPL-3.0-only ; voir `LICENSE`.

Depuis les mises à jour signées (DEC-046), l'exécutable lie aussi `ureq` (client HTTP), `native-tls` (le TLS du système : `schannel` sous Windows, OpenSSL sous Linux), `minisign-verify` et leurs dépendances : 13 composants de plus qu'au 2026-11-09. La fonctionnalité `native-tls-no-default` de `ureq` n'embarque pas la liste des certificats racine de Mozilla (`webpki-root-certs`, CDLA-Permissive-2.0), que l'application n'utilise pas (DEC-047).

| Composant | Version | Licence | Écosystème | Catégorie |
|---|---|---|---|---|
| adler2 | 2.0.1 | 0BSD OR MIT OR Apache-2.0 | rust | permissive |
| aho-corasick | 1.1.5 | Unlicense OR MIT | rust | permissive |
| alloc-no-stdlib | 3.0.0 | BSD-3-Clause | rust | permissive |
| alloc-stdlib | 0.3.0 | BSD-3-Clause | rust | permissive |
| anyhow | 1.0.104 | MIT OR Apache-2.0 | rust | permissive |
| base64 | 0.23.1 | MIT OR Apache-2.0 | rust | permissive |
| base64ct | 1.8.3 | Apache-2.0 OR MIT | rust | permissive |
| bit-set | 0.8.0 | Apache-2.0 OR MIT | rust | permissive |
| bit-vec | 0.8.0 | Apache-2.0 OR MIT | rust | permissive |
| bitflags | 1.3.2 | MIT/Apache-2.0 | rust | permissive |
| bitflags | 2.13.2 | MIT OR Apache-2.0 | rust | permissive |
| block-buffer | 0.10.4 | MIT OR Apache-2.0 | rust | permissive |
| block-buffer | 0.12.1 | MIT OR Apache-2.0 | rust | permissive |
| brotli | 9.1.1 | BSD-3-Clause AND MIT | rust | permissive |
| brotli-decompressor | 6.2.0 | BSD-3-Clause/MIT | rust | permissive |
| bs58 | 0.5.1 | MIT/Apache-2.0 | rust | permissive |
| bstr | 1.13.1 | MIT OR Apache-2.0 | rust | permissive |
| byteorder | 1.5.0 | Unlicense OR MIT | rust | permissive |
| bytes | 1.12.1 | MIT | rust | permissive |
| camino | 1.2.6 | MIT OR Apache-2.0 | rust | permissive |
| cargo_metadata | 0.19.2 | MIT | rust | permissive |
| cargo-platform | 0.1.9 | MIT OR Apache-2.0 | rust | permissive |
| cfb | 0.14.0 | MIT | rust | permissive |
| cfg-if | 1.0.5 | MIT OR Apache-2.0 | rust | permissive |
| chrono | 0.4.45 | MIT OR Apache-2.0 | rust | permissive |
| const-oid | 0.10.2 | Apache-2.0 OR MIT | rust | permissive |
| cookie | 0.18.2 | MIT OR Apache-2.0 | rust | permissive |
| cpufeatures | 0.2.17 | MIT OR Apache-2.0 | rust | permissive |
| cpufeatures | 0.3.1 | MIT OR Apache-2.0 | rust | permissive |
| crc32fast | 1.5.4 | MIT OR Apache-2.0 | rust | permissive |
| crossbeam-channel | 0.5.17 | MIT OR Apache-2.0 | rust | permissive |
| crossbeam-utils | 0.8.23 | MIT OR Apache-2.0 | rust | permissive |
| crypto-common | 0.1.7 | MIT OR Apache-2.0 | rust | permissive |
| crypto-common | 0.2.2 | MIT OR Apache-2.0 | rust | permissive |
| cssparser | 0.37.0 | MPL-2.0 | rust | copyleft-faible |
| cssparser-macros | 0.7.1 | MPL-2.0 | rust | copyleft-faible |
| ctor | 1.0.13 | Apache-2.0 OR MIT | rust | permissive |
| darling | 0.24.1 | MIT | rust | permissive |
| darling_core | 0.24.1 | MIT | rust | permissive |
| darling_macro | 0.24.1 | MIT | rust | permissive |
| defmt | 1.2.0 | MIT OR Apache-2.0 | rust | permissive |
| defmt-macros | 1.2.0 | MIT OR Apache-2.0 | rust | permissive |
| defmt-parser | 1.1.0 | MIT OR Apache-2.0 | rust | permissive |
| der | 0.8.3 | Apache-2.0 OR MIT | rust | permissive |
| deranged | 0.5.9 | MIT OR Apache-2.0 | rust | permissive |
| derive_more | 2.1.1 | MIT | rust | permissive |
| derive_more-impl | 2.1.1 | MIT | rust | permissive |
| digest | 0.10.7 | MIT OR Apache-2.0 | rust | permissive |
| digest | 0.11.3 | MIT OR Apache-2.0 | rust | permissive |
| dirs | 7.0.0 | MIT OR Apache-2.0 | rust | permissive |
| dirs-sys | 0.5.0 | MIT OR Apache-2.0 | rust | permissive |
| displaydoc | 0.2.7 | MIT OR Apache-2.0 | rust | permissive |
| dom_query | 0.28.0 | MIT | rust | permissive |
| dpi | 0.1.2 | Apache-2.0 AND MIT | rust | permissive |
| dtoa | 1.0.11 | MIT OR Apache-2.0 | rust | permissive |
| dtoa-short | 0.3.5 | MPL-2.0 | rust | copyleft-faible |
| dunce | 1.0.5 | CC0-1.0 OR MIT-0 OR Apache-2.0 | rust | permissive |
| dyn-clone | 1.0.20 | MIT OR Apache-2.0 | rust | permissive |
| equivalent | 1.0.3 | Apache-2.0 OR MIT | rust | permissive |
| erased-serde | 0.4.11 | MIT OR Apache-2.0 | rust | permissive |
| fastrand | 2.5.0 | Apache-2.0 OR MIT | rust | permissive |
| fdeflate | 0.3.7 | MIT OR Apache-2.0 | rust | permissive |
| flate2 | 1.1.10 | MIT OR Apache-2.0 | rust | permissive |
| fnv | 1.0.7 | Apache-2.0 / MIT | rust | permissive |
| foldhash | 0.2.0 | Zlib | rust | permissive |
| form_urlencoded | 1.2.2 | MIT OR Apache-2.0 | rust | permissive |
| generic-array | 0.14.7 | MIT | rust | permissive |
| getrandom | 0.3.4 | MIT OR Apache-2.0 | rust | permissive |
| getrandom | 0.4.3 | MIT OR Apache-2.0 | rust | permissive |
| glob | 0.3.4 | MIT OR Apache-2.0 | rust | permissive |
| globset | 0.4.21 | Unlicense OR MIT | rust | permissive |
| hashbrown | 0.12.3 | MIT OR Apache-2.0 | rust | permissive |
| hashbrown | 0.17.1 | MIT OR Apache-2.0 | rust | permissive |
| heck | 0.5.0 | MIT OR Apache-2.0 | rust | permissive |
| hex | 0.4.3 | MIT OR Apache-2.0 | rust | permissive |
| html5ever | 0.39.0 | MIT OR Apache-2.0 | rust | permissive |
| http | 1.5.0 | MIT OR Apache-2.0 | rust | permissive |
| httparse | 1.10.1 | MIT OR Apache-2.0 | rust | permissive |
| hybrid-array | 0.4.15 | MIT OR Apache-2.0 | rust | permissive |
| ico | 0.6.0 | MIT | rust | permissive |
| icu_collections | 2.4.0 | Unicode-3.0 | rust | permissive |
| icu_locale_core | 2.4.0 | Unicode-3.0 | rust | permissive |
| icu_normalizer | 2.4.0 | Unicode-3.0 | rust | permissive |
| icu_normalizer_data | 2.4.0 | Unicode-3.0 | rust | permissive |
| icu_properties | 2.4.0 | Unicode-3.0 | rust | permissive |
| icu_properties_data | 2.4.0 | Unicode-3.0 | rust | permissive |
| icu_provider | 2.4.0 | Unicode-3.0 | rust | permissive |
| ident_case | 1.0.1 | MIT/Apache-2.0 | rust | permissive |
| idna | 1.1.0 | MIT OR Apache-2.0 | rust | permissive |
| idna_adapter | 1.2.2 | Apache-2.0 OR MIT | rust | permissive |
| indexmap | 1.9.3 | Apache-2.0 OR MIT | rust | permissive |
| indexmap | 2.14.2 | Apache-2.0 OR MIT | rust | permissive |
| infer | 0.22.0 | MIT | rust | permissive |
| itoa | 1.0.18 | MIT OR Apache-2.0 | rust | permissive |
| jiff | 0.2.39 | Unlicense OR MIT | rust | permissive |
| jiff-core | 0.1.2 | Unlicense OR MIT | rust | permissive |
| jiff-tzdb | 0.1.9 | Unlicense OR MIT | rust | permissive |
| jiff-tzdb-platform | 0.1.3 | Unlicense OR MIT | rust | permissive |
| json-patch | 4.2.0 | MIT/Apache-2.0 | rust | permissive |
| jsonptr | 0.7.1 | MIT OR Apache-2.0 | rust | permissive |
| keyboard-types | 0.8.3 | MIT OR Apache-2.0 | rust | permissive |
| libc | 0.2.191 | MIT OR Apache-2.0 | rust | permissive |
| litemap | 0.8.3 | Unicode-3.0 | rust | permissive |
| lock_api | 0.4.14 | MIT OR Apache-2.0 | rust | permissive |
| log | 0.4.35 | MIT OR Apache-2.0 | rust | permissive |
| markup5ever | 0.39.0 | MIT OR Apache-2.0 | rust | permissive |
| memchr | 2.8.3 | Unlicense OR MIT | rust | permissive |
| mime | 0.3.18 | MIT OR Apache-2.0 | rust | permissive |
| minisign-verify | 0.3.0 | MIT | rust | permissive |
| miniz_oxide | 0.8.9 | MIT OR Zlib OR Apache-2.0 | rust | permissive |
| miniz_oxide | 0.9.1 | MIT OR Zlib OR Apache-2.0 | rust | permissive |
| mio | 1.2.4 | MIT | rust | permissive |
| muda | 0.20.0 | Apache-2.0 OR MIT | rust | permissive |
| native-tls | 0.2.18 | MIT OR Apache-2.0 | rust | permissive |
| new_debug_unreachable | 1.0.6 | MIT | rust | permissive |
| num-conv | 0.2.2 | MIT OR Apache-2.0 | rust | permissive |
| num-traits | 0.2.19 | MIT OR Apache-2.0 | rust | permissive |
| once_cell | 1.21.4 | MIT OR Apache-2.0 | rust | permissive |
| option-ext | 0.2.0 | MPL-2.0 | rust | copyleft-faible |
| parking_lot | 0.12.5 | MIT OR Apache-2.0 | rust | permissive |
| parking_lot_core | 0.9.12 | MIT OR Apache-2.0 | rust | permissive |
| pem-rfc7468 | 1.0.0 | Apache-2.0 OR MIT | rust | permissive |
| percent-encoding | 2.3.2 | MIT OR Apache-2.0 | rust | permissive |
| phf | 0.13.1 | MIT | rust | permissive |
| phf_generator | 0.13.1 | MIT | rust | permissive |
| phf_macros | 0.13.1 | MIT | rust | permissive |
| phf_shared | 0.13.1 | MIT | rust | permissive |
| pin-project-lite | 0.2.17 | Apache-2.0 OR MIT | rust | permissive |
| plist | 1.10.3 | MIT | rust | permissive |
| png | 0.18.1 | MIT OR Apache-2.0 | rust | permissive |
| potential_utf | 0.1.6 | Unicode-3.0 | rust | permissive |
| powerfmt | 0.2.1 | MIT OR Apache-2.0 | rust | permissive |
| precomputed-hash | 0.1.1 | MIT | rust | permissive |
| proc-macro2 | 1.0.107 | MIT OR Apache-2.0 | rust | permissive |
| quick-xml | 0.42.0 | MIT | rust | permissive |
| quote | 1.0.47 | MIT OR Apache-2.0 | rust | permissive |
| raw-window-handle | 0.6.2 | MIT OR Apache-2.0 OR Zlib | rust | permissive |
| ref-cast | 1.0.27 | MIT OR Apache-2.0 | rust | permissive |
| ref-cast-impl | 1.0.27 | MIT OR Apache-2.0 | rust | permissive |
| regex | 1.13.1 | MIT OR Apache-2.0 | rust | permissive |
| regex-automata | 0.4.18 | MIT OR Apache-2.0 | rust | permissive |
| regex-syntax | 0.8.11 | MIT OR Apache-2.0 | rust | permissive |
| rfd | 0.17.2 | MIT | rust | permissive |
| rustc-hash | 2.1.3 | Apache-2.0 OR MIT | rust | permissive |
| rustls-pki-types | 1.16.0 | MIT OR Apache-2.0 | rust | permissive |
| same-file | 1.0.6 | Unlicense/MIT | rust | permissive |
| schannel | 0.1.30 | MIT | rust | permissive |
| schemars | 0.8.22 | MIT | rust | permissive |
| schemars | 0.9.0 | MIT | rust | permissive |
| schemars | 1.2.3 | MIT | rust | permissive |
| schemars_derive | 0.8.22 | MIT | rust | permissive |
| scopeguard | 1.2.0 | MIT OR Apache-2.0 | rust | permissive |
| selectors | 0.38.0 | MPL-2.0 | rust | copyleft-faible |
| semver | 1.0.28 | MIT OR Apache-2.0 | rust | permissive |
| serde | 1.0.229 | MIT OR Apache-2.0 | rust | permissive |
| serde_core | 1.0.229 | MIT OR Apache-2.0 | rust | permissive |
| serde_derive | 1.0.229 | MIT OR Apache-2.0 | rust | permissive |
| serde_derive_internals | 0.29.1 | MIT OR Apache-2.0 | rust | permissive |
| serde_json | 1.0.154 | MIT OR Apache-2.0 | rust | permissive |
| serde_repr | 0.1.21 | MIT OR Apache-2.0 | rust | permissive |
| serde_spanned | 1.1.2 | MIT OR Apache-2.0 | rust | permissive |
| serde_with | 3.24.0 | MIT OR Apache-2.0 | rust | permissive |
| serde_with_macros | 3.24.0 | MIT OR Apache-2.0 | rust | permissive |
| serde-untagged | 0.1.9 | MIT OR Apache-2.0 | rust | permissive |
| serialize-to-javascript | 0.1.2 | MIT OR Apache-2.0 | rust | permissive |
| serialize-to-javascript-impl | 0.1.2 | MIT OR Apache-2.0 | rust | permissive |
| servo_arc | 0.4.3 | MIT OR Apache-2.0 | rust | permissive |
| sha2 | 0.10.9 | MIT OR Apache-2.0 | rust | permissive |
| sha2 | 0.11.1 | MIT OR Apache-2.0 | rust | permissive |
| simd-adler32 | 0.3.10 | MIT | rust | permissive |
| siphasher | 1.0.4 | MIT OR Apache-2.0 | rust | permissive |
| smallvec | 1.16.4 | MIT OR Apache-2.0 | rust | permissive |
| socket2 | 0.6.5 | MIT OR Apache-2.0 | rust | permissive |
| softbuffer | 0.4.8 | MIT OR Apache-2.0 | rust | permissive |
| stable_deref_trait | 1.2.1 | MIT OR Apache-2.0 | rust | permissive |
| string_cache | 0.9.0 | MIT OR Apache-2.0 | rust | permissive |
| strsim | 0.11.1 | MIT | rust | permissive |
| syn | 2.0.119 | MIT OR Apache-2.0 | rust | permissive |
| syn | 3.0.9 | MIT OR Apache-2.0 | rust | permissive |
| synstructure | 0.14.0 | MIT | rust | permissive |
| tao | 0.37.2 | Apache-2.0 | rust | permissive |
| tauri | 2.12.5 | Apache-2.0 OR MIT | rust | permissive |
| tauri-codegen | 2.7.4 | Apache-2.0 OR MIT | rust | permissive |
| tauri-macros | 2.7.4 | Apache-2.0 OR MIT | rust | permissive |
| tauri-plugin-dialog | 2.8.4 | Apache-2.0 OR MIT | rust | permissive |
| tauri-plugin-fs | 2.7.1 | Apache-2.0 OR MIT | rust | permissive |
| tauri-runtime | 2.12.2 | Apache-2.0 OR MIT | rust | permissive |
| tauri-runtime-wry | 2.12.3 | Apache-2.0 OR MIT | rust | permissive |
| tauri-utils | 2.10.2 | Apache-2.0 OR MIT | rust | permissive |
| tempfile | 3.27.0 | MIT OR Apache-2.0 | rust | permissive |
| tendril | 0.5.1 | MIT OR Apache-2.0 | rust | permissive |
| thiserror | 2.0.21 | MIT OR Apache-2.0 | rust | permissive |
| thiserror-impl | 2.0.21 | MIT OR Apache-2.0 | rust | permissive |
| time | 0.3.55 | MIT OR Apache-2.0 | rust | permissive |
| time-core | 0.1.9 | MIT OR Apache-2.0 | rust | permissive |
| time-macros | 0.2.32 | MIT OR Apache-2.0 | rust | permissive |
| tinystr | 0.8.5 | Unicode-3.0 | rust | permissive |
| tinyvec | 1.13.3 | Zlib OR Apache-2.0 OR MIT | rust | permissive |
| tokio | 1.54.1 | MIT | rust | permissive |
| toml | 1.2.0+spec-1.1.0 | MIT OR Apache-2.0 | rust | permissive |
| toml_datetime | 1.1.2+spec-1.1.0 | MIT OR Apache-2.0 | rust | permissive |
| toml_parser | 1.1.5+spec-1.1.0 | MIT OR Apache-2.0 | rust | permissive |
| toml_writer | 1.2.0+spec-1.1.0 | MIT OR Apache-2.0 | rust | permissive |
| tracing | 0.1.44 | MIT | rust | permissive |
| tracing-core | 0.1.36 | MIT | rust | permissive |
| tray-icon | 0.25.1 | MIT OR Apache-2.0 | rust | permissive |
| typeid | 1.0.3 | MIT OR Apache-2.0 | rust | permissive |
| typenum | 1.20.1 | MIT OR Apache-2.0 | rust | permissive |
| unicode-ident | 1.0.27 | (MIT OR Apache-2.0) AND Unicode-3.0 | rust | permissive |
| unicode-segmentation | 1.13.3 | MIT OR Apache-2.0 | rust | permissive |
| ureq | 3.5.2 | MIT OR Apache-2.0 | rust | permissive |
| ureq-proto | 0.7.1 | MIT OR Apache-2.0 | rust | permissive |
| url | 2.5.8 | MIT OR Apache-2.0 | rust | permissive |
| urlpattern | 0.6.0 | MIT | rust | permissive |
| utf_types | 1.0.0 | Apache-2.0 OR MIT | rust | permissive |
| utf8_iter | 1.1.0 | Apache-2.0 OR MIT | rust | permissive |
| utf8-zero | 0.8.1 | MIT OR Apache-2.0 | rust | permissive |
| uuid | 1.29.0 | Apache-2.0 OR MIT | rust | permissive |
| walkdir | 2.5.0 | Unlicense/MIT | rust | permissive |
| web_atoms | 0.2.6 | MIT OR Apache-2.0 | rust | permissive |
| web-time | 1.1.0 | MIT OR Apache-2.0 | rust | permissive |
| webview2-com | 0.39.1 | MIT | rust | permissive |
| webview2-com-macros | 0.8.1 | MIT | rust | permissive |
| webview2-com-sys | 0.39.1 | MIT | rust | permissive |
| winapi-util | 0.1.11 | Unlicense OR MIT | rust | permissive |
| window-vibrancy | 0.8.1 | Apache-2.0 OR MIT | rust | permissive |
| windows | 0.62.2 | MIT OR Apache-2.0 | rust | permissive |
| windows-collections | 0.3.2 | MIT OR Apache-2.0 | rust | permissive |
| windows-core | 0.62.2 | MIT OR Apache-2.0 | rust | permissive |
| windows-future | 0.3.2 | MIT OR Apache-2.0 | rust | permissive |
| windows-implement | 0.60.2 | MIT OR Apache-2.0 | rust | permissive |
| windows-interface | 0.59.3 | MIT OR Apache-2.0 | rust | permissive |
| windows-link | 0.2.1 | MIT OR Apache-2.0 | rust | permissive |
| windows-numerics | 0.3.1 | MIT OR Apache-2.0 | rust | permissive |
| windows-result | 0.4.1 | MIT OR Apache-2.0 | rust | permissive |
| windows-strings | 0.5.1 | MIT OR Apache-2.0 | rust | permissive |
| windows-sys | 0.61.2 | MIT OR Apache-2.0 | rust | permissive |
| windows-threading | 0.2.1 | MIT OR Apache-2.0 | rust | permissive |
| windows-version | 0.1.7 | MIT OR Apache-2.0 | rust | permissive |
| winnow | 1.0.5 | MIT | rust | permissive |
| writeable | 0.6.4 | Unicode-3.0 | rust | permissive |
| wry | 0.57.1 | Apache-2.0 OR MIT | rust | permissive |
| yoke | 0.8.4 | Unicode-3.0 | rust | permissive |
| yoke-derive | 0.8.4 | Unicode-3.0 | rust | permissive |
| zerofrom | 0.1.8 | Unicode-3.0 | rust | permissive |
| zerofrom-derive | 0.1.8 | Unicode-3.0 | rust | permissive |
| zeroize | 1.9.1 | Apache-2.0 OR MIT | rust | permissive |
| zerotrie | 0.2.5 | Unicode-3.0 | rust | permissive |
| zerovec | 0.11.9 | Unicode-3.0 | rust | permissive |
| zerovec-derive | 0.11.7 | Unicode-3.0 | rust | permissive |
| zlib-rs | 0.6.8 | Zlib | rust | permissive |
| zmij | 1.0.23 | MIT | rust | permissive |
| @tauri-apps/api | 2.12.4 | Apache-2.0 OR MIT | typescript | permissive |
| @types/react | 19.3.0 | MIT | typescript | permissive |
| @types/trusted-types | 2.0.7 | MIT | typescript | permissive |
| csstype | 3.2.3 | MIT | typescript | permissive |
| dompurify | 3.4.15 | (MPL-2.0 OR Apache-2.0) | typescript | permissive |
| marked | 14.0.0 | MIT | typescript | permissive |
| monaco-editor | 0.57.0 | MIT | typescript | permissive |
| react | 19.3.1 | MIT | typescript | permissive |
| react-dom | 19.3.1 | MIT | typescript | permissive |
| scheduler | 0.28.0 | MIT | typescript | permissive |
| zustand | 5.0.16 | MIT | typescript | permissive |
