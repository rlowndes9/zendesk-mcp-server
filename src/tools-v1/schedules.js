import { z } from 'zod';
import {
  getClientFactory,
  getCache,
  instanceSession,
} from '../lib/foundations.js';
import { ResourceCache } from '../lib/resource-cache.js';
import {
  LIST_PAGINATION_SCHEMA,
  fetchAndSlice,
} from '../lib/list-pagination.js';
import { success, fromError } from '../lib/response-envelope.js';
import { asMcp } from './meta.js';

const KIND = 'schedules';
const BH_KIND = 'business_hours';

export const schedulesTools = [
  {
    name: 'list_schedules',
    description:
      'Returns business-hours schedules as paginated skeletons (`id`, `name`, `time_zone`, `updated_at`). Default `limit: 100`; pass `cursor`, `fields`, `filter`, or `verbose: true` to inline weekly intervals. **Plan-gated**, schedules require Professional+. **For "what are the actual business hours?" call `list_business_hours`** with a `schedule_id`, it composes intervals + holidays, which the schedule list alone doesn\'t cover.',
    schema: {
      instance: z
        .string()
        .optional()
        .describe('Override the sticky instance for this call'),
      verbose: z
        .boolean()
        .optional()
        .describe('Return full schedule objects (with intervals) instead of the thin projection'),
      refresh: z
        .boolean()
        .optional()
        .describe('Bypass cache and re-fetch from Zendesk'),
      ...LIST_PAGINATION_SCHEMA,
    },
    handler: async ({
      instance,
      verbose = false,
      refresh = false,
      limit,
      cursor,
      fields,
      filter,
    } = {}) => {
      let resolved = null;
      try {
        resolved = instanceSession.resolve(instance);
        const factory = await getClientFactory();
        const client = factory.getClient(resolved);
        const cache = getCache();

        const { value, fetched_at, cached_at } = await fetchAndSlice({
          client,
          cache,
          instance: resolved,
          kind: KIND,
          queryHash: 'all',
          refresh,
          limit,
          cursor,
          fields,
          verbose,
          filter,
          path: '/business_hours/schedules.json',
          itemsKey: 'schedules',
        });

        return asMcp(success(resolved, value, { fetched_at, cached_at }));
      } catch (err) {
        return asMcp(fromError(err, resolved));
      }
    },
  },
  {
    name: 'get_schedule',
    description:
      'Fetch one schedule by ID, including its weekly `intervals`. **For schedule + holidays in one call use `list_business_hours`**, Zendesk holidays live on a separate sub-resource and `get_schedule` alone won\'t surface them.',
    schema: {
      id: z.union([z.number(), z.string()]).describe('Schedule ID'),
      instance: z
        .string()
        .optional()
        .describe('Override the sticky instance for this call'),
    },
    handler: async ({ id, instance } = {}) => {
      let resolved = null;
      try {
        resolved = instanceSession.resolve(instance);
        const factory = await getClientFactory();
        const client = factory.getClient(resolved);
        const cache = getCache();

        const key = ResourceCache.makeKey(resolved, KIND, `id:${id}`, true);
        const { value, fetched_at, cached_at } = await cache.getOrFetch(
          key,
          undefined,
          async () => {
            const body = await client.request(
              'GET',
              `/business_hours/schedules/${encodeURIComponent(id)}.json`,
              {},
            );
            return body.schedule;
          },
        );

        return asMcp(success(resolved, value, { fetched_at, cached_at }));
      } catch (err) {
        return asMcp(fromError(err, resolved));
      }
    },
  },
  {
    name: 'list_business_hours',
    description:
      'Composite that returns the weekly `intervals` and the `holidays` for one schedule in a single response. **Reach for this rather than `get_schedule`** when answering "when is this schedule open?", Zendesk splits hours and holidays across two endpoints; this tool joins them. Plan-gated alongside schedules themselves.',
    schema: {
      schedule_id: z
        .union([z.number(), z.string()])
        .describe('Schedule ID to load business hours for'),
      instance: z
        .string()
        .optional()
        .describe('Override the sticky instance for this call'),
      refresh: z
        .boolean()
        .optional()
        .describe('Bypass cache and re-fetch from Zendesk'),
    },
    handler: async ({ schedule_id, instance, refresh = false } = {}) => {
      let resolved = null;
      try {
        resolved = instanceSession.resolve(instance);
        const factory = await getClientFactory();
        const client = factory.getClient(resolved);
        const cache = getCache();

        const key = ResourceCache.makeKey(
          resolved,
          BH_KIND,
          `schedule:${schedule_id}`,
          true,
        );

        if (refresh) cache.invalidate(resolved, [BH_KIND]);

        const { value, fetched_at, cached_at } = await cache.getOrFetch(
          key,
          undefined,
          async () => {
            const scheduleBody = await client.request(
              'GET',
              `/business_hours/schedules/${encodeURIComponent(schedule_id)}.json`,
              {},
            );
            const schedule = scheduleBody.schedule || {};

            let holidays = [];
            try {
              const holidaysBody = await client.request(
                'GET',
                `/business_hours/schedules/${encodeURIComponent(schedule_id)}/holidays.json`,
                {},
              );
              holidays = Array.isArray(holidaysBody.holidays)
                ? holidaysBody.holidays
                : [];
            } catch (_e) {
              // Holidays endpoint may 404 on schedules without any holidays;
              // tolerate and return an empty array rather than failing the call.
              holidays = [];
            }

            return {
              schedule_id: schedule.id ?? schedule_id,
              name: schedule.name ?? null,
              time_zone: schedule.time_zone ?? null,
              intervals: Array.isArray(schedule.intervals) ? schedule.intervals : [],
              holidays,
            };
          },
        );

        return asMcp(success(resolved, value, { fetched_at, cached_at }));
      } catch (err) {
        return asMcp(fromError(err, resolved));
      }
    },
  },
];
