<!DOCTYPE html>
<html lang="en">
    <head>
    	<?php
        $title = isset($_GET['title']) ? $_GET['title'] : '';
        $desc = isset($_GET['desc']) ? $_GET['desc'] : '';
        $thumb = isset($_GET['thumb']) ? $_GET['thumb'] : '';
        $url = isset($_GET['url']) ? $_GET['url'] : 'https://codecanyon.net/user/demonisblack';
        ?>
        <title><?php echo $title;?></title>
        <meta property="og:title" content="<?php echo $title;?>" />
        <meta property="og:description" content="<?php echo $desc;?> "/>
        <meta property="og:image" content="<?php echo $thumb;?>"/>
        <meta property="og:url" content="<?php echo $url;?>" />
    </head>
    <body>
        <script>
            window.location.href = "<?php echo $url;?>";
        </script>
    </body>
</html>