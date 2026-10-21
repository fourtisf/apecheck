/**
 * Agent screenshots under SCREENSHOT_DIR, served at /shots/* (HANDOFF §12.6).
 * Images only, no directory listing, no dotfiles, traversal refused by @fastify/static.
 * Files never change once written (one file per check step), so they cache for a long time.
 */
import fs from 'node:fs';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

/** screenshots (jpg), share cards (png) and coin logos under logos/ (png, jpg, webp, gif; never svg) */
const IMAGE_RE = /\.(?:jpe?g|png|webp|gif)$/i;

export async function registerShots(app: FastifyInstance, dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  await app.register(fastifyStatic, {
    root: dir,
    prefix: '/shots/',
    decorateReply: false,
    index: false,
    list: false,
    dotfiles: 'deny',
    redirect: false,
    etag: true,
    lastModified: true,
    maxAge: '30d',
    immutable: true,
    allowedPath: (pathName: string) => IMAGE_RE.test(pathName) && !pathName.includes('\0'),
    setHeaders: reply => {
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Cross-Origin-Resource-Policy', 'cross-origin');
      reply.header('Content-Security-Policy', "default-src 'none'; sandbox");
    },
  });
}
