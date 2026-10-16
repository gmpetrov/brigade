// A member's notifications: the preset they chose, and the browsers and
// installed apps that receive them (src/notifications.ts sends them).
import { PushDeviceInput, SetNotifyPreset, type NotificationSettings } from '@brigade/contracts'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { prisma } from '../db.js'
import { sendTest, vapid } from '../notifications.js'
import { parseBody, requireUser, requireWorkspace, type AppEnv } from '../scope.js'

export const notifications = new Hono<AppEnv>()
  .use(requireUser, requireWorkspace)

  .get('/', async (c) => {
    const member = await prisma.member.findUniqueOrThrow({
      where: { id: c.var.scope.memberId },
      select: { notify: true },
    })
    return c.json({
      preset: member.notify,
      publicKey: vapid()?.publicKey ?? null,
    } satisfies NotificationSettings)
  })

  .put('/preset', async (c) => {
    const { preset } = await parseBody(c.req.raw, SetNotifyPreset)
    await prisma.member.update({ where: { id: c.var.scope.memberId }, data: { notify: preset } })
    return c.body(null, 204)
  })

  /** This browser receives the member's notifications; a browser is one user's at a time. */
  .post('/devices', async (c) => {
    if (!vapid())
      throw new HTTPException(409, { message: 'Notifications are not set up on this Brigade' })
    const { endpoint, keys } = await parseBody(c.req.raw, PushDeviceInput)
    const device = { userId: c.var.userId, p256dh: keys.p256dh, auth: keys.auth }
    await prisma.pushDevice.upsert({
      where: { endpoint },
      create: { endpoint, ...device },
      update: device,
    })
    return c.body(null, 204)
  })

  /** This browser no longer receives them (turned off, or signing out). */
  .post('/devices/remove', async (c) => {
    const { endpoint } = await parseBody(c.req.raw, PushDeviceInput.pick({ endpoint: true }))
    await prisma.pushDevice.deleteMany({ where: { endpoint, userId: c.var.userId } })
    return c.body(null, 204)
  })

  .post('/test', async (c) => c.json(await sendTest(c.var.userId)))
