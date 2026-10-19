# ApeCheck — paket untuk Claude Code

## Isi paket
- `design/apecheck.html` — desain final (buka di browser untuk lihat)
- `HANDOFF.md` — spesifikasi lengkap: arsitektur, cara kerja agent, skor, X bot, keamanan, deploy
- `CLAUDE_CODE_PROMPT.md` — prompt yang tinggal di-copy ke Claude Code
- `prisma/schema.prisma` — struktur database
- `reference/scoring.ts` — rumus skor (sama persis dengan desain)
- `.env.example` — daftar semua API key yang perlu diisi

## Cara pakai
1. Extract zip ini ke folder kosong, misalnya `apecheck/`.
2. Buka Claude Code di folder itu.
3. Buka `CLAUDE_CODE_PROMPT.md`, copy semua teks di bawah garis, lalu paste ke Claude Code.
4. Claude Code akan membangun bertahap: M1 (website + pengecekan), M2 (X bot), M3 (fitur tambahan), M4 (API untuk developer).
5. Isi `.env` dari `.env.example` dengan key di bawah ini. Key yang belum ada tidak menghalangi build; bagian itu akan di-stub dulu.

## Yang perlu disiapkan
| Kebutuhan | Untuk apa |
|---|---|
| Domain **apecheck.io** + DNS ke IP VPS | Website dan API |
| VPS Hostinger min. 4 vCPU / 8 GB RAM | Browser agent butuh RAM besar |
| **Anthropic API key** | Otak agent (cek klaim, menilai, jawab pertanyaan) |
| Akun X **@ApeCheckBot** + X Developer (pay-per-use) + label "Automated" | Bot auto-reply |
| Helius, Etherscan V2, TronGrid, RPC (termasuk Robinhood Chain) | Data on-chain |
| API internal Fourtis (DevRadar, BundleScan, WhaleFlow) | Data deployer, bundle, holder |
| GitHub token | Cek repo dan aktivitas commit |
| Keputusan token $APECHECK | Akses Pro/Max (boleh menyusul) |

Wallet sungguhan **tidak** dibutuhkan: agent hanya memakai wallet tiruan dan mensimulasikan transaksi, jadi tidak ada dana yang bisa hilang.
