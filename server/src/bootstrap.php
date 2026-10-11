<?php

declare(strict_types=1);

use ChrisManager\Env;
use ChrisManager\Timezone;

require dirname(__DIR__) . '/vendor/autoload.php';

Env::load(dirname(__DIR__) . '/.env');
date_default_timezone_set(Timezone::resolve(Env::get('APP_TIMEZONE', 'system'), dirname(__DIR__) . '/storage/timezone.cache'));
