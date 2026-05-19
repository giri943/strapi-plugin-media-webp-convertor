import type { Core } from '@strapi/strapi';
import { permissionActionDefinitions } from './permissions';

const register = ({ strapi }: { strapi: Core.Strapi }) => {
  if (strapi.isLoaded) {
    strapi.log.warn(
      '[strapi-media-webp-convertor] Skipping permission registration: Strapi is already loaded (unexpected for register phase).'
    );
    return;
  }

  try {
    strapi.service('admin::permission').actionProvider.registerMany(permissionActionDefinitions);
  } catch (err) {
    strapi.log.error(
      '[strapi-media-webp-convertor] Failed to register admin permission actions. Grant access via Roles only after fixing this error.',
      err
    );
  }
};

export default register;