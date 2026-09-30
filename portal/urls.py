from django.urls import path

from . import views

urlpatterns = [
    path("", views.downloads, name="downloads"),
    path("login/", views.login, name="login"),
    path("verify/", views.verify, name="verify"),
    path("logout/", views.logout, name="logout"),
    path("download/<uuid:release_id>/", views.download, name="download"),
    path("admin/", views.releases, name="admin"),
    path("admin/customers/", views.customers, name="customers"),
    path(
        "admin/customers/<int:customer_id>/access/", views.customer_access, name="customer_access"
    ),
    path("admin/releases/", views.releases, name="releases"),
    path("admin/releases/upload/", views.start_upload, name="start_upload"),
    path("admin/releases/<uuid:release_id>/finish/", views.finish_upload, name="finish_upload"),
    path("admin/releases/<uuid:release_id>/edit/", views.edit_release, name="edit_release"),
    path(
        "admin/releases/<uuid:release_id>/publish/", views.publish_release, name="publish_release"
    ),
    path("admin/activity/", views.activity, name="activity"),
    path("health/", views.health, name="health"),
]
