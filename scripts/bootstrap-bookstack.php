<?php
// Local development only: run through bootstrap-bookstack.mjs, never web serve.
// Uses upstream Laravel models without modifying BookStack source files.
require '/app/www/vendor/autoload.php';
$app = require '/app/www/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
$input = json_decode(stream_get_contents(STDIN), true, 512, JSON_THROW_ON_ERROR);
foreach (['tokenId', 'tokenSecret', 'adminPassword'] as $key) {
    if (empty($input[$key]) || strlen($input[$key]) < 32) {
        throw new RuntimeException('Required local bootstrap credential missing.');
    }
}

Illuminate\Support\Facades\DB::transaction(function () use ($input) {
    $role = BookStack\Users\Models\Role::firstOrCreate(
        ['display_name' => 'AssetDesk integration'],
        ['description' => 'API content creation and linking; no user, role, settings, or deletion permissions.', 'system_name' => '']
    );
    $permissionNames = ['access-api'];
    foreach (['bookshelf', 'book', 'chapter', 'page'] as $entity) {
        foreach (['view', 'create', 'update'] as $operation) {
            $permissionNames[] = "$entity-$operation-all";
        }
    }
    $permissions = BookStack\Permissions\Models\RolePermission::whereIn('name', $permissionNames)->get();
    if ($permissions->count() !== count($permissionNames)) {
        throw new RuntimeException('Unexpected BookStack permission schema. Use manual API setup instead.');
    }
    $role->permissions()->sync($permissions->pluck('id')->all());

    $user = BookStack\Users\Models\User::where('email', 'assetdesk-service@example.invalid')->first();
    if (!$user) {
        $user = app(BookStack\Users\UserRepo::class)->createWithoutActivity([
            'name' => 'AssetDesk integration',
            'email' => 'assetdesk-service@example.invalid',
            'password' => bin2hex(random_bytes(32)),
        ], true);
    }
    $user->roles()->sync([$role->id]);
    $token = BookStack\Api\ApiToken::where('token_id', $input['tokenId'])->first();
    if ($token && (int)$token->user_id !== (int)$user->id) {
        throw new RuntimeException('Token ID belongs to another user; refusing to overwrite it.');
    }
    $token ??= new BookStack\Api\ApiToken();
    $token->token_id = $input['tokenId'];
    $token->secret = Illuminate\Support\Facades\Hash::make($input['tokenSecret']);
    $token->name = 'AssetDesk local development';
    $token->user_id = $user->id;
    $token->expires_at = now()->addYear()->format('Y-m-d');
    $token->save();

    // Replace only a stock default admin password. Never reset a user-customized login.
    $admin = BookStack\Users\Models\User::where('email', 'admin@admin.com')->first();
    if ($admin && Illuminate\Support\Facades\Hash::check('password', $admin->password)) {
        $admin->password = Illuminate\Support\Facades\Hash::make($input['adminPassword']);
        $admin->save();
    }
});
Illuminate\Support\Facades\Artisan::call('bookstack:regenerate-permissions');
echo "Local API user and token provisioned. Stock admin password replaced if still present.\n";
