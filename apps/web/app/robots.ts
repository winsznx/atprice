import type { MetadataRoute } from 'next';
import { publicEnv } from '@/lib/env/public';
import { buildRobots } from '@/lib/seo';

export default function robots(): MetadataRoute.Robots {
  return buildRobots(publicEnv.network);
}
