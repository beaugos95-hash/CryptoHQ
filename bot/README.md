# Meme Coin Trading Bot (Solana)

Bot de trading automatisé pour meme coins sur Solana, conçu pour être **rapide** et **prudent** :

- **Découverte** : scanne en continu les tokens tendance via l'API DexScreener (boosts + profils récents) et filtre par liquidité, FDV, volume, âge de la paire, pression acheteuse et momentum.
- **Anti-rug on-chain** : avant chaque achat, vérifie directement sur la blockchain que la *mint authority* et la *freeze authority* sont révoquées, et que la distribution des holders n'est pas trop concentrée.
- **Exécution** : swaps via l'agrégateur **Jupiter** (meilleure route sur tous les DEX Solana), avec *priority fees* pour une inclusion rapide et confirmation vérifiée de chaque transaction.
- **Gestion du risque** : take-profit, stop-loss dur, trailing stop et sortie forcée après une durée maximale. Nombre de positions simultanées plafonné, cooldown anti re-buy.
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
| `TAKE_PROFIT_PCT` | `60` | Vente automatique à +60 % |
| `STOP_LOSS_PCT` | `25` | Vente automatique à −25 % |
| `TRAILING_STOP_PCT` | `20` | Vente si le prix retombe de 20 % sous son pic (en profit) |
| `MAX_HOLD_MINUTES` | `60` | Sortie forcée après 60 min |
| `MIN_LIQUIDITY_USD` | `20000` | Liquidité minimale du pool |
| `MAX_TOP_HOLDER_PCT` | `15` | Concentration max du plus gros holder hors LP |
| `SLIPPAGE_BPS` | `300` | Slippage max (3 %) |

La liste complète des paramètres est documentée dans [`.env.example`](.env.example).

## Architecture

```
src/
├── index.ts      # Boucle principale (monitoring rapide + scans périodiques)
├── config.ts     # Configuration typée + validation au démarrage
├── discovery.ts  # Découverte et filtrage des tokens (DexScreener)
├── safety.ts     # Contrôles anti-rug on-chain (mint/freeze authority, holders)
├── jupiter.ts    # Quotes et exécution des swaps (Jupiter), confirmation on-chain
├── trader.ts     # Ouverture/fermeture des positions, TP/SL/trailing/timeout
├── state.ts      # Persistance atomique de l'état
├── wallet.ts     # Connexion RPC + keypair + vérification du solde
├── http.ts       # Client HTTP avec timeout et retries exponentiels
├── logger.ts     # Logs structurés
└── types.ts      # Types partagés
```

## Avertissement

Le trading de meme coins est **extrêmement risqué** : la majorité de ces tokens perdent la quasi-totalité de leur valeur, et aucun filtre automatique ne détecte 100 % des rugs ou honeypots. Ce bot est fourni à titre éducatif, sans aucune garantie de gains. N'engagez que des fonds que vous pouvez vous permettre de perdre.
