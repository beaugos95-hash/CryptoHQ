# Meme Coin Trading Bot (Solana)

Bot de trading automatisé pour meme coins sur Solana, conçu pour être **rapide** et **prudent** :

- **Découverte** : scanne en continu les tokens tendance via l'API DexScreener (boosts + profils récents) et filtre par liquidité, FDV, volume, âge de la paire, pression acheteuse et momentum.
- **Anti-rug on-chain** : avant chaque achat, vérifie directement sur la blockchain que la *mint authority* et la *freeze authority* sont révoquées, et que la distribution des holders n'est pas trop concentrée (repli sur l'API RugCheck si le RPC est limité).
- **Anti-honeypot** : avant chaque achat, simule la revente du montant exact qui serait détenu ; si aucune route de vente n'existe ou si l'aller-retour achat+vente perd plus de `MAX_ROUND_TRIP_LOSS_PCT`, le token est rejeté (taxes cachées, liquidité à sens unique).
- **Exécution** : swaps via l'agrégateur **Jupiter** (meilleure route sur tous les DEX Solana), avec *priority fees* pour une inclusion rapide et confirmation vérifiée de chaque transaction.
- **Gestion du risque** : take-profit partiel (TP1 : vend la moitié à +40 % et laisse courir le reste), take-profit final, stop-loss dur, trailing stop, sortie forcée après une durée maximale, plafond de perte journalière (pause des achats jusqu'au lendemain UTC), nombre de positions simultanées plafonné, cooldown anti re-buy.
- **Notifications Telegram** (optionnel) : achat, vente, TP1 et alertes envoyés sur votre téléphone.
- **Mode paper trading par défaut** (`DRY_RUN=true`) : le bot simule les trades sans jamais envoyer de transaction réelle. Idéal pour valider la stratégie avant d'engager des fonds.
- **État persistant** : positions et PnL sont sauvegardés atomiquement dans `state/bot-state.json` — un crash ou un redémarrage ne perd rien.

## Installation

```bash
cd bot
npm install
cp .env.example .env   # puis ajustez les valeurs
```

## Lancement

```bash
# Mode paper trading (par défaut, aucun fonds réel utilisé)
npm run dev

# Build production
npm run build && npm start

# Statistiques des trades (win rate, PnL par raison de sortie, historique)
npm run stats
```

## Passer en mode réel

1. Testez d'abord **plusieurs jours en paper trading** et vérifiez le PnL dans les logs et `state/bot-state.json`.
2. Créez un **wallet dédié** avec un montant limité que vous acceptez de perdre entièrement.
3. Utilisez un **RPC privé** (Helius, Triton, QuickNode…) — le RPC public est trop lent et trop limité pour du trading réel.
4. Dans `.env` : renseignez `PRIVATE_KEY` (clé privée base58 du wallet dédié) et mettez `DRY_RUN=false`.

## Paramètres principaux

| Variable | Défaut | Rôle |
|---|---|---|
| `BUY_AMOUNT_SOL` | `0.05` | Montant de SOL engagé par position |
| `MAX_OPEN_POSITIONS` | `3` | Positions simultanées maximum |
| `TP1_PCT` / `TP1_SELL_FRACTION` | `40` / `0.5` | À +40 %, vend 50 % de la position et laisse courir le reste |
| `TAKE_PROFIT_PCT` | `100` | Clôture totale à +100 % |
| `STOP_LOSS_PCT` | `25` | Vente automatique à −25 % |
| `TRAILING_STOP_PCT` | `20` | Vente si le prix retombe de 20 % sous son pic (en profit) |
| `MAX_HOLD_MINUTES` | `60` | Sortie forcée après 60 min |
| `MAX_DAILY_LOSS_SOL` | `0.25` | Pause des achats jusqu'au lendemain UTC après −0.25 SOL réalisés |
| `MIN_LIQUIDITY_USD` | `20000` | Liquidité minimale du pool |
| `MAX_TOP_HOLDER_PCT` | `15` | Concentration max du plus gros holder hors LP |
| `HONEYPOT_CHECK` | `true` | Simule la revente avant chaque achat |
| `MAX_ROUND_TRIP_LOSS_PCT` | `10` | Perte max tolérée sur l'aller-retour achat+vente |
| `SLIPPAGE_BPS` | `300` | Slippage max (3 %) |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | *(vide)* | Notifications Telegram (optionnel) |

La liste complète des paramètres est documentée dans [`.env.example`](.env.example).

## Architecture

```
src/
├── index.ts      # Boucle principale (monitoring rapide + scans périodiques)
├── config.ts     # Configuration typée + validation au démarrage
├── discovery.ts  # Découverte et filtrage des tokens (DexScreener)
├── safety.ts     # Contrôles anti-rug (mint/freeze authority, holders, RugCheck)
├── jupiter.ts    # Quotes et exécution des swaps (Jupiter), confirmation on-chain
├── trader.ts     # Positions : anti-honeypot, TP1 partiel, TP/SL/trailing/timeout
├── stats.ts      # Rapport de statistiques (npm run stats)
├── notify.ts     # Notifications Telegram (optionnel)
├── state.ts      # Persistance atomique de l'état
├── wallet.ts     # Connexion RPC + keypair + vérification du solde
├── http.ts       # Client HTTP avec timeout et retries exponentiels
├── logger.ts     # Logs structurés
└── types.ts      # Types partagés
```

## Avertissement

Le trading de meme coins est **extrêmement risqué** : la majorité de ces tokens perdent la quasi-totalité de leur valeur, et aucun filtre automatique ne détecte 100 % des rugs ou honeypots. Ce bot est fourni à titre éducatif, sans aucune garantie de gains. N'engagez que des fonds que vous pouvez vous permettre de perdre.
