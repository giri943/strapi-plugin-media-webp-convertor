import { Box, Flex, Link, Typography } from '@strapi/design-system';

const SPONSOR_URL = 'https://github.com/sponsors/giri943';
const REPOSITORY_URL = 'https://github.com/giri943/strapi-plugin-media-webp-convertor';

/**
 * One quiet line at the foot of the plugin page, below the tabs, so it never gets in the way of
 * the settings or a running migration.
 */
export const SupportFooter = () => (
  <Box paddingTop={8} paddingBottom={4}>
    <Flex justifyContent="center" gap={2} wrap="wrap">
      <Typography variant="pi" textColor="neutral500">
        Media WebP &amp; Migration is free and open source.
      </Typography>
      <Link href={SPONSOR_URL} isExternal>
        ♥ Sponsor this plugin
      </Link>
      <Typography variant="pi" textColor="neutral500" aria-hidden>
        ·
      </Typography>
      <Link href={`${REPOSITORY_URL}/issues`} isExternal>
        Report an issue
      </Link>
    </Flex>
  </Box>
);
